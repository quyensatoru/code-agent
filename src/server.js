import express from 'express';
import { query } from './query.js';
import { OpenRouterClient } from './openrouter.js';
import { toolDefinitions } from './tools.js';

export function createServer(defaults = {}) {
    const app = express();
    app.use(express.json({ limit: '2mb' }));

    app.get('/health', (_req, res) => {
        res.json({ ok: true });
    });

    app.get('/v1/tools', (_req, res) => {
        res.json({ tools: toolDefinitions });
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

    // Run query() and collect the SDK message stream. Defaults to read-only
    // (plan) since the server has no TTY to confirm tool permissions.
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

            const { prompt, ...rest } = body;
            const options = {
                ...defaults,
                ...rest,
                permissionMode,
                cwd: body.cwd || defaults.cwd || process.cwd(),
            };

            const messages = [];
            let result = '';
            let sessionId;
            for await (const message of query({ prompt, options })) {
                messages.push(message);
                if (message.type === 'result') {
                    sessionId = message.session_id;
                    result = message.subtype === 'success' ? message.result : (message.errors || []).join('\n');
                } else if (message.type === 'system') {
                    sessionId = message.session_id;
                }
            }
            res.json({ result, sessionId, messages });
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
