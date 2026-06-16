import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { USER_AGENT, truncate } from '../tools/shared.js';

// Minimal GitLab REST v4 client + git clone, for provisioning a workspace from
// a group's repos. Token is read from env (GITLAB_TOKEN); host from GITLAB_URL
// (default https://gitlab.com), so self-hosted instances work too.

const execFileAsync = promisify(execFile);
const DEFAULT_BASE_URL = 'https://gitlab.com';

export function gitlabApiBase(baseUrl) {
    return `${String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '')}/api/v4`;
}

async function api(baseUrl, token, endpoint) {
    const response = await fetch(`${gitlabApiBase(baseUrl)}${endpoint}`, {
        headers: { 'PRIVATE-TOKEN': token, 'user-agent': USER_AGENT },
    });
    const text = await response.text();
    if (!response.ok) {
        throw new Error(`GitLab ${response.status}: ${truncate(text || response.statusText, 300)}`);
    }
    return text ? JSON.parse(text) : null;
}

export async function getGroup(baseUrl, token, group) {
    const g = await api(baseUrl, token, `/groups/${encodeURIComponent(group)}`);
    return { id: g.id, path: g.path, name: g.name, full_path: g.full_path };
}

// Direct projects of the group only (no subgroups), non-archived, sorted.
export async function listGroupProjects(baseUrl, token, group) {
    const out = [];
    for (let page = 1; ; page += 1) {
        const items = await api(
            baseUrl,
            token,
            `/groups/${encodeURIComponent(group)}/projects` +
                `?per_page=100&page=${page}&include_subgroups=false&archived=false&order_by=path&sort=asc`
        );
        out.push(...items);
        if (!items.length || items.length < 100) break;
    }
    return out.map((p) => ({
        id: p.id,
        name: p.name,
        path: p.path,
        path_with_namespace: p.path_with_namespace,
        http_url_to_repo: p.http_url_to_repo,
        default_branch: p.default_branch,
    }));
}

// Embed the token only for the clone, then scrub it from the persisted remote
// so it never lingers in .git/config.
export function tokenizeCloneUrl(httpUrl, token) {
    return httpUrl.replace(/^(https?:\/\/)/i, `$1oauth2:${token}@`);
}

// Files whose names this OS can't represent (e.g. a trailing space/dot on
// Windows). Returns { skipped } — a partial checkout is kept, not deleted,
// since the rest of the repo is still usable.
export function parseSkippedFiles(output = '') {
    const skipped = [...output.matchAll(/unable to create (?:file|symlink) ([^\n:]+):/g)].map((m) =>
        m[1].trim()
    );
    return [...new Set(skipped)];
}

export async function cloneRepo(httpUrl, token, dest) {
    await fs.mkdir(path.dirname(dest), { recursive: true });
    let skipped = [];
    try {
        // core.longpaths=true avoids "checkout failed" when the nested workspace
        // path exceeds Windows MAX_PATH (260 chars).
        const { stderr } = await execFileAsync(
            'git',
            ['-c', 'core.longpaths=true', 'clone', tokenizeCloneUrl(httpUrl, token), dest],
            { timeout: 600000 }
        );
        skipped = parseSkippedFiles(stderr); // warn-and-exit-0 case
    } catch (error) {
        const output = `${error.stderr || ''}\n${error.stdout || ''}`;
        const gitInitialized = await pathExists(path.join(dest, '.git'));
        // Objects fetched but some files have OS-illegal names → keep the partial
        // tree (the rest is usable). Only a real failure (no .git) is fatal.
        if (!(gitInitialized && /unable to create|checkout|working tree/i.test(output))) {
            await fs.rm(dest, { recursive: true, force: true }).catch(() => {});
            throw new Error(`git clone failed for ${httpUrl}: ${(error.stderr || error.message || '').trim()}`);
        }
        skipped = parseSkippedFiles(output);
    }
    await execFileAsync('git', ['-C', dest, 'remote', 'set-url', 'origin', httpUrl]).catch(() => {});
    await execFileAsync('git', ['-C', dest, 'config', 'core.longpaths', 'true']).catch(() => {});
    return { skipped };
}

async function pathExists(target) {
    try {
        await fs.access(target);
        return true;
    } catch {
        return false;
    }
}
