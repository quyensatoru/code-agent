import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from '../src/server/index.js';

function listen(app) {
    return new Promise((resolve) => {
        const server = app.listen(0, '127.0.0.1', () => {
            resolve({ server, base: `http://127.0.0.1:${server.address().port}` });
        });
    });
}

test('server exposes health, active queries, and interrupt 404 for unknown ids', async () => {
    const { server, base } = await listen(createServer());
    try {
        const health = await (await fetch(`${base}/health`)).json();
        assert.deepEqual(health, { ok: true });

        const active = await (await fetch(`${base}/v1/query/active`)).json();
        assert.deepEqual(active, { active: [] });

        const missing = await fetch(`${base}/v1/query/nope/interrupt`, { method: 'POST' });
        assert.equal(missing.status, 404);

        const tools = await (await fetch(`${base}/v1/tools`)).json();
        assert.ok(tools.tools.some((t) => t.function?.name === 'BrowserSnapshot'));
        assert.ok(tools.tools.some((t) => t.function?.name === 'Git'));
    } finally {
        server.close();
    }
});
