// Read-only datastore inspection — so the agent can read realtime state when a
// bug is in the data/infra, not the code. SQL (Postgres/MySQL/SQLite), Redis,
// MongoDB, and RabbitMQ. Connection strings come from env (DATABASE_URL /
// REDIS_URL / MONGODB_URL / RABBITMQ_URL) or a `url` arg. Drivers are
// lazy-imported (no hard dependency); a missing one returns an install hint.
// Every tool enforces read-only access.
//
// RabbitMQ uses AMQP (amqplib): queue depth (passive check) and a
// non-destructive peek (messages are requeued, never consumed). For the
// management HTTP API (exchanges/bindings/overview) use HttpProbe against
// e.g. GET http://host:15672/api/queues with a Basic auth header.
//
// Many configs? Give each connection an alias in .oragent/datasources.json (or
// the DATASOURCES env) and pass `source:"<alias>"` instead of a raw url — see
// src/tools/datasources.js and the DataSources tool.

import { listDataSources, resolveSource } from './datasources.js';

const SOURCE_PROP = {
    type: 'string',
    description: 'Named datasource alias (from .oragent/datasources.json / DATASOURCES env). Overrides env defaults; an explicit url overrides this. List them with the DataSources tool.',
};

export const dataToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'DataSources',
            description:
                'List configured datasource aliases (from .oragent/datasources.json and the DATASOURCES env) with type and host — credentials redacted. Use an alias as the "source" arg of SqlQuery / RedisCommand / MongoQuery / RabbitMQ instead of pasting a connection URL.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'SqlQuery',
            description:
                'Run a READ-ONLY SQL query (SELECT/WITH/EXPLAIN/SHOW/DESCRIBE/PRAGMA) against Postgres, MySQL, or SQLite and return rows. Connection from DATABASE_URL or the url arg (scheme picks the driver). Mutations are rejected. Use it to check whether the data behind an issue is actually correct.',
            parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: { type: 'string' },
                    source: SOURCE_PROP,
                    url: { type: 'string', description: 'Override DATABASE_URL (postgres://, mysql://, sqlite:/file path).' },
                    max_rows: { type: 'integer', minimum: 1, maximum: 1000, default: 200 },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'RedisCommand',
            description:
                'Run a READ-ONLY Redis command (GET/HGETALL/LRANGE/KEYS/SCAN/TTL/INFO/…) and return the reply. Connection from REDIS_URL or the url arg. Writes (SET/DEL/FLUSH/…) are rejected. Use it to inspect cache/session/queue keys.',
            parameters: {
                type: 'object',
                required: ['command'],
                properties: {
                    command: { type: 'string' },
                    args: { type: 'array', items: { type: 'string' }, default: [] },
                    source: SOURCE_PROP,
                    url: { type: 'string', description: 'Override REDIS_URL.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'MongoQuery',
            description:
                'Run a READ-ONLY MongoDB operation (find/count/distinct/aggregate/listCollections) and return documents. Connection from MONGODB_URL (or MONGO_URL) + MONGODB_DB, or the url/db args. Write stages ($out/$merge) and write operations are rejected.',
            parameters: {
                type: 'object',
                required: ['collection'],
                properties: {
                    collection: { type: 'string' },
                    operation: {
                        type: 'string',
                        enum: ['find', 'count', 'distinct', 'aggregate', 'listCollections'],
                        default: 'find',
                    },
                    filter: { type: 'object', description: 'Query filter for find/count.' },
                    pipeline: { type: 'array', items: { type: 'object' }, description: 'Stages for aggregate.' },
                    field: { type: 'string', description: 'Field for distinct.' },
                    limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
                    source: SOURCE_PROP,
                    url: { type: 'string', description: 'Override MONGODB_URL.' },
                    db: { type: 'string', description: 'Override MONGODB_DB / source db.' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'RabbitMQ',
            description:
                'Inspect RabbitMQ over AMQP (READ-ONLY). operation "queue": passive check of a queue — returns messageCount + consumerCount (use it to see if messages are piling up or have no consumer). operation "peek": read up to N messages WITHOUT consuming them (they are requeued; redelivered flag/order may change). Connection from RABBITMQ_URL/AMQP_URL or the url arg. For exchanges/bindings/overview use HttpProbe against the management API (port 15672).',
            parameters: {
                type: 'object',
                required: ['queue'],
                properties: {
                    operation: {
                        type: 'string',
                        enum: ['queue', 'peek'],
                        default: 'queue',
                    },
                    queue: { type: 'string', description: 'Queue name.' },
                    count: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 50,
                        default: 5,
                        description: 'peek: number of messages to read (non-destructively requeued).',
                    },
                    source: SOURCE_PROP,
                    url: { type: 'string', description: 'Override RABBITMQ_URL (amqp://user:pass@host:5672).' },
                },
            },
        },
    },
];

export function createDataHandlers({ cwd = process.cwd() } = {}) {
    return {
        DataSources: () => listDataSources(cwd),
        SqlQuery: (args) => sqlQuery(args, cwd),
        RedisCommand: (args) => redisCommand(args, cwd),
        MongoQuery: (args) => mongoQuery(args, cwd),
        RabbitMQ: (args) => rabbitMq(args, cwd),
    };
}

// --- SQL ---

const SQL_READ_FIRST = new Set([
    'select', 'with', 'explain', 'show', 'describe', 'desc', 'pragma', 'table', 'values',
]);
const SQL_FORBIDDEN =
    /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|merge|replace|into|attach|vacuum|set)\b/i;

export function assertReadOnlySql(sql) {
    const stripped = String(sql || '')
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/--[^\n]*/g, ' ')
        .trim()
        .replace(/;+\s*$/, '');
    if (!stripped) throw new Error('Empty query');
    if (stripped.includes(';')) throw new Error('Only a single read-only statement is allowed');
    const first = stripped.split(/\s+/)[0].toLowerCase();
    if (!SQL_READ_FIRST.has(first)) throw new Error(`Only read-only queries are allowed (got "${first}")`);
    if (SQL_FORBIDDEN.test(stripped)) throw new Error('Query contains a forbidden mutating keyword');
    return stripped;
}

async function sqlQuery({ query, url, source, max_rows: maxRows = 200 }, cwd) {
    const entry = await resolveSource(source, cwd, 'sql');
    url = url || entry?.url || process.env.DATABASE_URL;
    if (!url) throw new Error('No database URL. Set DATABASE_URL, pass url, or use source.');
    const sql = assertReadOnlySql(query);
    const scheme = url.split(':')[0].toLowerCase();
    if (scheme === 'postgres' || scheme === 'postgresql') return pgQuery(url, sql, maxRows);
    if (scheme === 'mysql') return mysqlQuery(url, sql, maxRows);
    if (scheme === 'sqlite' || scheme === 'file' || /\.(db|sqlite|sqlite3)$/.test(url)) {
        return sqliteQuery(url, sql, maxRows);
    }
    throw new Error(`Unsupported SQL URL scheme "${scheme}"`);
}

async function pgQuery(url, sql, maxRows) {
    const pg = defaultOf(await lazy('pg'));
    const client = new pg.Client({ connectionString: url, statement_timeout: 15000 });
    await client.connect();
    try {
        const res = await client.query(sql);
        const rows = res.rows || [];
        return { dialect: 'postgres', row_count: rows.length, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
    } finally {
        await client.end().catch(() => {});
    }
}

async function mysqlQuery(url, sql, maxRows) {
    const mysql = defaultOf(await lazy('mysql2/promise'));
    const conn = await mysql.createConnection(url);
    try {
        const [result] = await conn.query({ sql, timeout: 15000 });
        const rows = Array.isArray(result) ? result : [];
        return { dialect: 'mysql', row_count: rows.length, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
    } finally {
        await conn.end().catch(() => {});
    }
}

async function sqliteQuery(url, sql, maxRows) {
    const Database = defaultOf(await lazy('better-sqlite3'));
    const file = url.replace(/^sqlite:\/\/?/, '').replace(/^file:/, '');
    const db = new Database(file, { readonly: true });
    try {
        const rows = db.prepare(sql).all();
        return { dialect: 'sqlite', row_count: rows.length, rows: rows.slice(0, maxRows), truncated: rows.length > maxRows };
    } finally {
        db.close();
    }
}

// --- Redis ---

const REDIS_READ = new Set([
    'GET', 'MGET', 'STRLEN', 'GETRANGE', 'EXISTS', 'TYPE', 'TTL', 'PTTL', 'KEYS', 'SCAN',
    'HGET', 'HGETALL', 'HMGET', 'HKEYS', 'HVALS', 'HLEN', 'HEXISTS', 'LRANGE', 'LLEN', 'LINDEX',
    'SMEMBERS', 'SCARD', 'SISMEMBER', 'SRANDMEMBER', 'ZRANGE', 'ZREVRANGE', 'ZCARD', 'ZSCORE',
    'ZRANK', 'DBSIZE', 'INFO', 'MEMORY', 'OBJECT', 'RANDOMKEY', 'PING', 'BITCOUNT', 'LPOS',
]);

export function assertReadOnlyRedis(command) {
    const cmd = String(command || '').trim().toUpperCase();
    if (!REDIS_READ.has(cmd)) throw new Error(`Only read-only Redis commands are allowed (got "${command}")`);
    return cmd;
}

async function redisCommand({ command, args = [], url, source }, cwd) {
    const entry = await resolveSource(source, cwd, 'redis');
    url = url || entry?.url || process.env.REDIS_URL;
    if (!url) throw new Error('No Redis URL. Set REDIS_URL, pass url, or use source.');
    const cmd = assertReadOnlyRedis(command);
    const redis = defaultOf(await lazy('redis'));
    const client = redis.createClient({ url });
    await client.connect();
    try {
        const result = await client.sendCommand([cmd, ...args.map(String)]);
        return { command: cmd, result };
    } finally {
        await client.quit().catch(() => {});
    }
}

// --- MongoDB ---

export function assertReadOnlyPipeline(pipeline = []) {
    for (const stage of pipeline) {
        if (stage && (stage.$out !== undefined || stage.$merge !== undefined)) {
            throw new Error('Aggregation write stages ($out/$merge) are not allowed');
        }
    }
    return pipeline;
}

async function mongoQuery({
    collection,
    operation = 'find',
    filter = {},
    pipeline = [],
    field,
    limit = 50,
    url,
    db,
    source,
}, cwd) {
    const entry = await resolveSource(source, cwd, 'mongo');
    url = url || entry?.url || process.env.MONGODB_URL || process.env.MONGO_URL;
    db = db || entry?.db || process.env.MONGODB_DB;
    if (!url) throw new Error('No Mongo URL. Set MONGODB_URL, pass url, or use source.');
    const mongodb = await lazy('mongodb');
    const MongoClient = (mongodb.default ?? mongodb).MongoClient;
    const client = new MongoClient(url);
    await client.connect();
    try {
        const database = client.db(db);
        if (operation === 'listCollections') {
            const names = (await database.listCollections().toArray()).map((c) => c.name);
            return { collections: names };
        }
        const col = database.collection(collection);
        if (operation === 'find') {
            return { rows: await col.find(filter).limit(Math.min(limit, 500)).toArray() };
        }
        if (operation === 'count') return { count: await col.countDocuments(filter) };
        if (operation === 'distinct') {
            if (!field) throw new Error('distinct requires a "field"');
            return { values: await col.distinct(field, filter) };
        }
        if (operation === 'aggregate') {
            assertReadOnlyPipeline(pipeline);
            return { rows: await col.aggregate(pipeline).toArray() };
        }
        throw new Error(`Unsupported operation "${operation}"`);
    } finally {
        await client.close().catch(() => {});
    }
}

// --- RabbitMQ (AMQP, read-only) ---

async function rabbitMq({ operation = 'queue', queue, count = 5, url, source }, cwd) {
    const entry = await resolveSource(source, cwd, 'rabbitmq');
    url = url || entry?.url || process.env.RABBITMQ_URL || process.env.AMQP_URL;
    if (!url) throw new Error('No RabbitMQ URL. Set RABBITMQ_URL, pass url, or use source.');
    if (!queue) throw new Error('queue is required');
    const amqp = defaultOf(await lazy('amqplib'));
    const conn = await amqp.connect(url);
    try {
        const channel = await conn.createChannel();
        // Surface AMQP channel errors (e.g. queue not found) as the tool error
        // instead of an unhandled 'error' event crashing the process.
        channel.on('error', () => {});
        try {
            if (operation === 'queue') {
                const ok = await channel.checkQueue(queue); // passive — read-only
                return {
                    queue: ok.queue,
                    messageCount: ok.messageCount,
                    consumerCount: ok.consumerCount,
                };
            }
            if (operation === 'peek') {
                const limit = Math.min(Math.max(Number(count) || 5, 1), 50);
                const held = [];
                for (let i = 0; i < limit; i += 1) {
                    const msg = await channel.get(queue, { noAck: false });
                    if (!msg) break;
                    held.push(msg);
                }
                const messages = held.map(decodeAmqpMessage);
                // Requeue everything — peek must not consume.
                for (const msg of held) channel.nack(msg, false, true);
                return { queue, peeked: messages.length, requeued: true, messages };
            }
            throw new Error(`Unsupported operation "${operation}"`);
        } finally {
            await channel.close().catch(() => {});
        }
    } finally {
        await conn.close().catch(() => {});
    }
}

function decodeAmqpMessage(msg) {
    const text = msg.content ? msg.content.toString('utf8') : '';
    let body;
    try {
        body = JSON.parse(text);
    } catch {
        body = text.length > 2000 ? `${text.slice(0, 2000)}…[truncated]` : text;
    }
    const props = msg.properties || {};
    return {
        routing_key: msg.fields?.routingKey,
        exchange: msg.fields?.exchange,
        redelivered: msg.fields?.redelivered,
        content_type: props.contentType,
        message_id: props.messageId,
        timestamp: props.timestamp,
        headers: props.headers,
        body,
    };
}

// --- shared ---

async function lazy(mod) {
    try {
        return await import(mod);
    } catch (error) {
        if (error?.code === 'ERR_MODULE_NOT_FOUND' || error?.code === 'MODULE_NOT_FOUND') {
            throw new Error(`This tool needs the "${mod}" package. Install it: npm i ${mod}`);
        }
        throw error;
    }
}

// CJS drivers expose their entry on `.default` under ESM import; named exports
// may also be present. Prefer default, fall back to the namespace.
function defaultOf(mod) {
    return mod.default ?? mod;
}
