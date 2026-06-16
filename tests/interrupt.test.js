import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { query } from '../src/core/query.js';

test('query() exposes interrupt() and aborting yields a resumable interrupted result', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'oragent-int-'));
    const generator = query({
        prompt: 'do something',
        options: { cwd, model: 'test/model', apiKey: 'test-key' },
    });
    assert.equal(typeof generator.interrupt, 'function');
    generator.interrupt(); // interrupt before the first model call

    const messages = [];
    for await (const message of generator) messages.push(message);

    assert.equal(messages[0].type, 'system');
    assert.equal(messages[0].subtype, 'init');
    const result = messages.at(-1);
    assert.equal(result.type, 'result');
    assert.equal(result.subtype, 'error_during_execution');
    assert.deepEqual(result.errors, ['Interrupted by user']);

    // History was persisted so the session is resumable.
    const sessionsDir = path.join(cwd, '.oragent', 'sessions');
    assert.ok(existsSync(sessionsDir));
    assert.ok(readdirSync(sessionsDir).some((f) => f.startsWith(result.session_id)));
});

test('caller-supplied abortController is honored', async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), 'oragent-int-'));
    const abortController = new AbortController();
    const generator = query({
        prompt: 'task',
        options: { cwd, model: 'test/model', apiKey: 'test-key', abortController },
    });
    assert.equal(generator.abortController, abortController);
    abortController.abort();

    const messages = [];
    for await (const message of generator) messages.push(message);
    assert.equal(messages.at(-1).subtype, 'error_during_execution');
});
