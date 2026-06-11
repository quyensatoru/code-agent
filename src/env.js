import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(cwd = process.cwd()) {
    const file = path.join(cwd, '.env');
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const index = trimmed.indexOf('=');
        if (index === -1) continue;
        const key = trimmed.slice(0, index).trim();
        const value = trimmed
            .slice(index + 1)
            .trim()
            .replace(/^["']|["']$/g, '');
        if (key && process.env[key] === undefined) process.env[key] = value;
    }
}
