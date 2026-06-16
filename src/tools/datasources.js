import { promises as fs } from 'node:fs';
import path from 'node:path';

// Named datasource registry, so a project with many DB / queue configs can give
// each one an alias once and let the agent pick it by name (the `source` arg of
// SqlQuery / RedisCommand / MongoQuery / RabbitMQ) instead of pasting URLs.
//
// Sources merge from, in increasing precedence:
//   1. <cwd>/.oragent/datasources.json   (gitignored — keep secrets here)
//   2. DATASOURCES env (JSON)
//   3. OPENROUTER_DATASOURCES env (JSON)
//
// Each entry: { type?: "sql"|"mongo"|"redis"|"rabbitmq", url: string, db?: string }

export async function loadDataSources(cwd = process.cwd()) {
    const sources = {};

    const file = path.join(path.resolve(cwd), '.oragent', 'datasources.json');
    try {
        const parsed = JSON.parse(await fs.readFile(file, 'utf8'));
        if (parsed && typeof parsed === 'object') Object.assign(sources, parsed.datasources || parsed);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw new Error(`Cannot read .oragent/datasources.json: ${error.message}`);
        }
    }

    for (const key of ['DATASOURCES', 'OPENROUTER_DATASOURCES']) {
        const raw = process.env[key];
        if (!raw) continue;
        try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') Object.assign(sources, parsed);
        } catch (error) {
            throw new Error(`${key} is not valid JSON: ${error.message}`);
        }
    }

    return sources;
}

// Resolve a source alias to its entry. Returns null when name is falsy (callers
// then fall back to the per-type env default). Throws on unknown alias or type
// mismatch so the model gets an actionable error instead of a connect failure.
export async function resolveSource(name, cwd, expectedType) {
    if (!name) return null;
    const all = await loadDataSources(cwd);
    const entry = all[name];
    if (!entry) {
        const available = Object.keys(all);
        throw new Error(
            `Unknown datasource "${name}". Available: ${available.join(', ') || '(none configured — see .oragent/datasources.json)'}`
        );
    }
    if (expectedType && entry.type && entry.type !== expectedType) {
        throw new Error(`Datasource "${name}" is type "${entry.type}", not usable as "${expectedType}"`);
    }
    return entry;
}

// List configured aliases with credentials redacted — for the DataSources tool.
export async function listDataSources(cwd = process.cwd()) {
    const all = await loadDataSources(cwd);
    const datasources = Object.entries(all).map(([name, entry]) => ({
        name,
        type: entry.type || inferType(entry.url),
        url: redactUrl(entry.url),
        db: entry.db,
    }));
    return { datasources, count: datasources.length };
}

export function redactUrl(url) {
    if (!url) return url;
    try {
        const parsed = new URL(url);
        if (parsed.password) parsed.password = '***';
        return parsed.toString();
    } catch {
        return String(url).replace(/(\/\/[^:/@]+:)[^@]+@/, '$1***@');
    }
}

function inferType(url = '') {
    const scheme = String(url).split(':')[0].toLowerCase();
    if (scheme.startsWith('postgres') || scheme === 'mysql' || scheme === 'sqlite' || scheme === 'file') return 'sql';
    if (scheme === 'mongodb' || scheme === 'mongodb+srv') return 'mongo';
    if (scheme === 'redis' || scheme === 'rediss') return 'redis';
    if (scheme === 'amqp' || scheme === 'amqps') return 'rabbitmq';
    return undefined;
}
