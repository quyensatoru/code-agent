// Read-only datastore inspection — so the agent can read realtime state when a
// bug is in the data/infra, not the code. SQL (Postgres/MySQL/SQLite), Redis,
// and MongoDB. Connection strings come from env (DATABASE_URL / REDIS_URL /
// MONGODB_URL) or a `url` arg. Drivers are lazy-imported (no hard dependency);
// a missing one returns an install hint. Every tool enforces read-only access.
//
// RabbitMQ and other HTTP-managed services: use HttpProbe against their
// management API (e.g. GET http://host:15672/api/queues with a Basic auth
// header) — no dedicated driver needed.

export const dataToolDefinitions = [
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
                    url: { type: 'string', description: 'Override MONGODB_URL.' },
                    db: { type: 'string', description: 'Override MONGODB_DB.' },
                },
            },
        },
    },
];

export function createDataHandlers() {
    return { SqlQuery: sqlQuery, RedisCommand: redisCommand, MongoQuery: mongoQuery };
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

async function sqlQuery({ query, url = process.env.DATABASE_URL, max_rows: maxRows = 200 }) {
    if (!url) throw new Error('No database URL. Set DATABASE_URL or pass url.');
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

async function redisCommand({ command, args = [], url = process.env.REDIS_URL }) {
    if (!url) throw new Error('No Redis URL. Set REDIS_URL or pass url.');
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
    url = process.env.MONGODB_URL || process.env.MONGO_URL,
    db = process.env.MONGODB_DB,
}) {
    if (!url) throw new Error('No Mongo URL. Set MONGODB_URL or pass url.');
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
