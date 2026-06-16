import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getGroup, listGroupProjects, cloneRepo } from './gitlab.js';

// Workspace provisioning: clone selected repos of a GitLab group into
// <workspace>/<group>/<repo>, where the coding agent and sandbox then run
// (cwd = workspace root). One workspace = one app/group. A marker file records
// what was provisioned so subsequent runs reuse it instead of re-cloning.

const MARKER = ['.oragent', 'workspace.json'];

function markerPath(workspace) {
    return path.join(path.resolve(workspace), ...MARKER);
}

export async function isProvisioned(workspace) {
    try {
        await fs.access(markerPath(workspace));
        return true;
    } catch {
        return false;
    }
}

export async function readWorkspace(workspace) {
    try {
        return JSON.parse(await fs.readFile(markerPath(workspace), 'utf8'));
    } catch {
        return null;
    }
}

// Clone the chosen repos. `selectProjects(projects) -> subset` lets the caller
// pick (interactively in the CLI, programmatically elsewhere).
export async function provisionWorkspace({
    workspace,
    group,
    baseUrl = process.env.GITLAB_URL,
    token = process.env.GITLAB_TOKEN,
    selectProjects,
    onLog = () => {},
}) {
    if (!token) throw new Error('Missing GITLAB_TOKEN in env.');
    if (!group) throw new Error('group is required to provision the workspace.');

    const root = path.resolve(workspace);
    const info = await getGroup(baseUrl, token, group);
    const projects = await listGroupProjects(baseUrl, token, group);
    if (!projects.length) throw new Error(`No projects found in group "${group}".`);

    const selected = (await selectProjects(projects)) || [];
    if (!selected.length) throw new Error('No repos selected.');

    const repos = [];
    for (const project of selected) {
        const dest = path.join(root, info.path, project.path);
        let skipped = [];
        try {
            await fs.access(path.join(dest, '.git'));
            onLog(`skip ${project.path} (already cloned)`);
        } catch {
            onLog(`cloning ${project.path_with_namespace}`);
            ({ skipped } = await cloneRepo(project.http_url_to_repo, token, dest));
            if (skipped.length) {
                onLog(
                    `  ⚠ ${skipped.length} file(s) not checked out (names this OS can't represent): ` +
                        `${skipped.slice(0, 3).join(', ')}${skipped.length > 3 ? ' …' : ''}`
                );
            }
        }
        repos.push({
            name: project.name,
            path: project.path,
            namespace: project.path_with_namespace,
            dir: path.relative(root, dest).split(path.sep).join('/'),
            ...(skipped.length ? { skipped } : {}),
        });
    }

    const marker = {
        group: info.path,
        baseUrl: baseUrl || 'https://gitlab.com',
        repos,
        provisionedAt: new Date().toISOString(),
    };
    await fs.mkdir(path.dirname(markerPath(root)), { recursive: true });
    await fs.writeFile(markerPath(root), JSON.stringify(marker, null, 2), 'utf8');
    return { workspace: root, ...marker };
}

// Parse a selection string like "all", "*", "1,3-5", "2" into 1-based indices.
export function parseSelection(input, max) {
    const text = String(input || '').trim().toLowerCase();
    if (text === 'all' || text === '*') return Array.from({ length: max }, (_, i) => i + 1);
    const picked = new Set();
    for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
        const range = part.match(/^(\d+)-(\d+)$/);
        if (range) {
            for (let i = Number(range[1]); i <= Number(range[2]); i += 1) {
                if (i >= 1 && i <= max) picked.add(i);
            }
        } else if (/^\d+$/.test(part)) {
            const n = Number(part);
            if (n >= 1 && n <= max) picked.add(n);
        }
    }
    return [...picked].sort((a, b) => a - b);
}
