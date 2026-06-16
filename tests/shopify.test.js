import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';
import { assertReadOnlyGraphQL, normalizeShopDomain } from '../src/tools/shopify.js';
import { runSupport } from '../src/support/index.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'oragent-shop-'));

test('normalizeShopDomain handles bare handle, full domain, and url', () => {
    assert.equal(normalizeShopDomain('my-store'), 'my-store.myshopify.com');
    assert.equal(normalizeShopDomain('my-store.myshopify.com'), 'my-store.myshopify.com');
    assert.equal(normalizeShopDomain('https://my-store.myshopify.com/admin'), 'my-store.myshopify.com');
    assert.throws(() => normalizeShopDomain(''), /shop is required/);
});

test('assertReadOnlyGraphQL accepts queries, rejects mutation/subscription', () => {
    assert.ok(assertReadOnlyGraphQL('{ shop { name } }'));
    assert.ok(assertReadOnlyGraphQL('query Q { currentAppInstallation { id } }'));
    assert.throws(() => assertReadOnlyGraphQL('mutation { appSubscriptionCreate { id } }'), /read-only/);
    assert.throws(() => assertReadOnlyGraphQL('subscription { x }'), /read-only/);
    assert.throws(() => assertReadOnlyGraphQL('  '), /Empty/);
});

test('ShopifyAdminGraphQL rejects a mutation before any network call', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('ShopifyAdminGraphQL', {
        query: 'mutation { webhookSubscriptionCreate { id } }',
        shop: 'my-store.myshopify.com',
        access_token: 'shptoken',
    });
    assert.equal(result.is_error, true);
    assert.match(result.content, /read-only/i);
});

test('ShopifyAdminGraphQL errors clearly without an access token', async () => {
    const prevToken = process.env.SHOPIFY_ACCESS_TOKEN;
    delete process.env.SHOPIFY_ACCESS_TOKEN;
    try {
        const runtime = createToolRuntime({ cwd: tmp() });
        const result = await runtime.execute('ShopifyAdminGraphQL', {
            query: '{ shop { name } }',
            shop: 'my-store',
        });
        assert.equal(result.is_error, true);
        assert.match(result.content, /access token/i);
    } finally {
        if (prevToken !== undefined) process.env.SHOPIFY_ACCESS_TOKEN = prevToken;
    }
});

test('ReportDiagnosis records a structured diagnosis and routes', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('ReportDiagnosis', {
        layer: 'theme_app_extension',
        root_cause: 'app embed disabled in theme',
        evidence: ['storefront DOM missing the app block', 'extension asset 200 but not injected'],
        confidence: 'high',
        route: 'merchant_action',
        recommended_action: 'ask merchant to enable the app embed in Theme editor',
    });
    assert.equal(result.is_error, false);
    const out = JSON.parse(result.content);
    assert.equal(out.recorded, true);
    assert.equal(out.diagnosis.layer, 'theme_app_extension');
    assert.match(out.directive, /not a code bug/i);
});

test('ReportDiagnosis validates required fields and enums', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const missing = await runtime.execute('ReportDiagnosis', { root_cause: 'x', route: 'code_fix', confidence: 'low' });
    assert.equal(missing.is_error, true);
    assert.match(missing.content, /layer/);

    const badEnum = await runtime.execute('ReportDiagnosis', {
        layer: 'theme_app_extension',
        root_cause: 'x',
        route: 'restart_everything',
        confidence: 'high',
    });
    assert.equal(badEnum.is_error, true);
    assert.match(badEnum.content, /INVALID INPUT/);
});

test('runSupport requires an issue', async () => {
    await assert.rejects(() => runSupport({ issue: '' }), /issue is required/);
});
