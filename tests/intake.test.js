import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'oragent-intake-'));

function listen(handler) {
    return new Promise((resolve) => {
        const server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () =>
            resolve({ server, base: `http://127.0.0.1:${server.address().port}` })
        );
    });
}

test('TriageIssue records a structured brief with unknowns', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('TriageIssue', {
        symptom: 'heatmap not visible',
        url: 'https://app.example.com/reports',
        expected: 'heatmap renders',
        actual: 'blank panel',
        unknowns: ['does the heatmap API return data?', 'any console error?'],
    });
    assert.equal(result.is_error, false);
    const out = JSON.parse(result.content);
    assert.equal(out.brief.symptom, 'heatmap not visible');
    assert.equal(out.brief.unknowns.length, 2);
    assert.match(out.directive, /BrowserSnapshot|HttpProbe/);
});

test('TriageIssue requires symptom and unknowns', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('TriageIssue', { symptom: 'x' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /INVALID INPUT/);
    assert.match(result.content, /unknowns/);
});

test('HttpProbe returns status, headers, and body; injects headers', async () => {
    const { server, base } = await listen((req, res) => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ auth: req.headers.authorization || null, path: req.url }));
    });
    try {
        const runtime = createToolRuntime({ cwd: tmp() });
        const result = await runtime.execute('HttpProbe', {
            url: `${base}/api/heatmap`,
            headers: { Authorization: 'Bearer tok' },
        });
        assert.equal(result.is_error, false);
        const probe = JSON.parse(result.content);
        assert.equal(probe.status, 200);
        assert.equal(probe.content_type, 'application/json');
        const body = JSON.parse(probe.body);
        assert.equal(body.auth, 'Bearer tok');
        assert.equal(body.path, '/api/heatmap');
    } finally {
        server.close();
    }
});

test('HttpProbe rejects non-idempotent methods via schema enum', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('HttpProbe', { url: 'http://127.0.0.1:1', method: 'POST' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /INVALID INPUT/);
});

test('BrowserSnapshot v2 captures network bodies, console errors, and runs actions', async (t) => {
    const hasBrowser = await canLaunch();
    if (!hasBrowser) {
        t.skip('no playwright/puppeteer installed');
        return;
    }
    const { server, base } = await listen((req, res) => {
        if (req.url === '/api/data') {
            res.setHeader('content-type', 'application/json');
            res.end(JSON.stringify({ points: [] }));
            return;
        }
        res.setHeader('content-type', 'text/html');
        res.end(`<!doctype html><html><body>
            <button id="load">load</button><div id="out"></div>
            <script>
              console.error('boom from page');
              document.getElementById('load').onclick = async () => {
                await fetch('/api/data');
                document.getElementById('out').textContent = 'loaded';
              };
            </script></body></html>`);
    });
    try {
        const runtime = createToolRuntime({ cwd: tmp() });
        const result = await runtime.execute('BrowserSnapshot', {
            url: base,
            actions: [{ type: 'click', selector: '#load' }, { type: 'wait_for', selector: '#out' }],
            network_filter: '/api/',
            selector: '#out',
        });
        assert.equal(result.is_error, false);
        const snap = JSON.parse(result.content);
        assert.ok(snap.console_errors.some((e) => e.includes('boom from page')));
        assert.ok(snap.network.some((n) => n.url.includes('/api/data') && n.body?.includes('points')));
        assert.ok(snap.actions.every((a) => a.startsWith('ok')));
        assert.match(snap.selected.text, /loaded/);
    } finally {
        server.close();
    }
});

async function canLaunch() {
    try {
        await import('playwright');
        return true;
    } catch {
        try {
            await import('puppeteer');
            return true;
        } catch {
            return false;
        }
    }
}
