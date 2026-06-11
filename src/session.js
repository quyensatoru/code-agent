import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export function newSessionId() {
    return randomUUID();
}

export async function loadSession(cwd, sessionId) {
    if (!sessionId) return [];
    const file = sessionPath(cwd, sessionId);
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text).messages || [];
}

export async function saveSession(cwd, sessionId, messages, meta = {}) {
    const dir = path.join(path.resolve(cwd), '.oragent', 'sessions');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
        path.join(dir, `${sessionId}.json`),
        JSON.stringify(
            { sessionId, updatedAt: new Date().toISOString(), ...meta, messages },
            null,
            2
        ),
        'utf8'
    );
}

export async function listSessions(cwd) {
    const dir = path.join(path.resolve(cwd), '.oragent', 'sessions');
    let entries = [];
    try {
        entries = await fs.readdir(dir);
    } catch {
        return [];
    }
    const sessions = [];
    for (const entry of entries.filter((name) => name.endsWith('.json'))) {
        const file = path.join(dir, entry);
        try {
            const data = JSON.parse(await fs.readFile(file, 'utf8'));
            sessions.push({
                sessionId: data.sessionId || entry.replace(/\.json$/, ''),
                updatedAt: data.updatedAt,
                model: data.model,
            });
        } catch {
            // Ignore corrupt local session files.
        }
    }
    return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

function sessionPath(cwd, sessionId) {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionId)) throw new Error('Invalid session id');
    return path.join(path.resolve(cwd), '.oragent', 'sessions', `${sessionId}.json`);
}
