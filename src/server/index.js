import { randomUUID } from 'node:crypto';
import express from 'express';
import { query } from '../core/query.js';
import { OpenRouterClient } from '../providers/openrouter.js';
import { toolDefinitions } from '../tools/index.js';
import { listSessions } from '../sessions/index.js';

// HTTP surface for the harness.
//
//   GET  /health
//   GET  /v1/tools
//   GET  /v1/models
//   GET  /v1/sessions                    persisted sessions (resume targets)
//   GET  /v1/query/active                sessionIds of currently running queries
//   POST /v1/query                       run a query
//        body: { prompt, sessionId?, resume?, stream?, ...options }
//        - sessionId: client-chosen id so the run can be interrupted later
//        - resume:    a previous sessionId to continue its conversation
//        - stream:    true -> SSE; each SDKMessage as a `data:` event (the
//          init event carries session_id, so streaming clients can interrupt
//          without pre-choosing an id)
//   POST /v1/query/:sessionId/interrupt  abort a running query; its history is
//        persisted, so it can be continued with { resume: sessionId }

export function createServer(defaults = {}) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    // sessionId -> generator (with .interrupt()) for in-flight queries.
    const active = new Map();

    app.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    app.get('/v1/tools', (_req, res) => {
        res.json({ tools: toolDefinitions });
    });

    app.get('/v1/sessions', async (req, res, next) => {
        try {
            const sessions = await listSessions(req.query.cwd || defaults.cwd || process.cwd());
            res.json({ sessions });
        } catch (error) {
            next(error);
        }
    });

    app.get('/v1/query/active', (_req, res) => {
        res.json({ active: [...active.keys()] });
    });

    app.post('/v1/query/:sessionId/interrupt', (req, res) => {
        const generator = active.get(req.params.sessionId);
        if (!generator) {
            res.status(404).json({ error: `No active query with sessionId ${req.params.sessionId}` });
            return;
        }
        generator.interrupt();
        res.json({ ok: true, sessionId: req.params.sessionId, resumable: true });
    });

    app.get('/v1/models', async (_req, res, next) => {
        try {
            const client = new OpenRouterClient(defaults);
            const models = await client.listModels();
            res.json({ models });
        } catch (error) {
            next(error);
        }
    });

    // Run query(). Defaults to read-only (plan) since the server has no TTY
    // to confirm tool permissions.
    app.post('/v1/query', async (req, res, next) => {
        try {
            const body = req.body || {};
            const permissionMode = body.permissionMode || defaults.permissionMode || 'plan';
            if (permissionMode === 'bypassPermissions' && !body.allowDangerouslySkipPermissions) {
                res.status(400).json({
                    error: 'permissionMode=bypassPermissions requires allowDangerouslySkipPermissions=true',
                });
                return;
            }

            const { prompt, stream, ...rest } = body;
            const sessionId = body.sessionId || body.resume || randomUUID();
            const options = {
                ...defaults,
                ...rest,
                sessionId,
                permissionMode,
                cwd: body.cwd || defaults.cwd || process.cwd(),
            };

            const generator = query({ prompt, options });
            active.set(sessionId, generator);

            try {
                if (stream) {
                    res.writeHead(200, {
                        'content-type': 'text/event-stream',
                        'cache-control': 'no-cache',
                        connection: 'keep-alive',
                    });
                    // A streaming client going away should stop the run (the
                    // session stays resumable).
                    req.on('close', () => generator.interrupt());
                    for await (const message of generator) {
                        res.write(`data: ${JSON.stringify(message)}\n\n`);
                    }
                    res.end();
                    return;
                }

                const messages = [];
                let result = '';
                let interrupted = false;
                for await (const message of generator) {
                    messages.push(message);
                    if (message.type === 'result') {
                        result =
                            message.subtype === 'success'
                                ? message.result
                                : (message.errors || []).join('\n');
                        interrupted = (message.errors || []).includes('Interrupted by user');
                    }
                }
                res.json({ result, sessionId, interrupted, messages });
            } finally {
                active.delete(sessionId);
            }
        } catch (error) {
            next(error);
        }
    });

    app.use((error, _req, res, _next) => {
        res.status(500).json({ error: error.message });
    });

    return app;
}

export function startServer({ port = 3333, host = '127.0.0.1', ...defaults } = {}) {
    const app = createServer(defaults);
    return new Promise((resolve) => {
        const server = app.listen(port, host, () =>
            resolve({ app, server, url: `http://${host}:${port}` })
        );
    });
}
