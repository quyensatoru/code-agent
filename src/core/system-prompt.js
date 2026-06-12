import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadMemoryIndex, memorySection } from '../memory/index.js';

// Assemble the final system prompt from the base prompt plus harness-supplied
// context: environment info, the project context doc (ORAGENT.md / AGENTS.md /
// CLAUDE.md), and the persistent memory index. Only applied when the caller
// uses the default/preset prompt — a custom string systemPrompt is sent as-is.

export const PROJECT_DOC_FILES = ['ORAGENT.md', 'AGENTS.md', 'CLAUDE.md'];
const MAX_PROJECT_DOC_CHARS = 24000;

export async function buildSystemPrompt({
    base,
    cwd,
    includeEnvInfo = true,
    loadProjectContext = true,
    memory = true,
}) {
    const sections = [base];
    if (includeEnvInfo) sections.push(envSection(cwd));
    if (loadProjectContext) {
        const doc = await readProjectDoc(cwd);
        if (doc) sections.push(doc);
    }
    if (memory) sections.push(memorySection(await loadMemoryIndex(cwd)));
    return sections.filter(Boolean).join('\n\n');
}

function envSection(cwd) {
    const lines = [
        '# Environment',
        `- Working directory: ${cwd}`,
        `- Platform: ${process.platform} (node ${process.version})`,
        `- Date: ${new Date().toISOString().slice(0, 10)}`,
    ];
    const git = gitInfo(cwd);
    if (git) lines.push(`- Git: ${git}`);
    return lines.join('\n');
}

function gitInfo(cwd) {
    try {
        const run = (cmd) =>
            execSync(cmd, { cwd, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
                .toString()
                .trim();
        const branch = run('git rev-parse --abbrev-ref HEAD');
        const dirty = run('git status --porcelain');
        const changed = dirty ? dirty.split('\n').length : 0;
        return `branch ${branch}${changed ? `, ${changed} changed file(s)` : ', clean'}`;
    } catch {
        return null;
    }
}

async function readProjectDoc(cwd) {
    for (const name of PROJECT_DOC_FILES) {
        try {
            const text = await fs.readFile(path.join(cwd, name), 'utf8');
            if (!text.trim()) continue;
            const body =
                text.length > MAX_PROJECT_DOC_CHARS
                    ? `${text.slice(0, MAX_PROJECT_DOC_CHARS)}\n[truncated]`
                    : text;
            return `# Project context (from ${name})\n${body.trim()}`;
        } catch {
            // try the next candidate
        }
    }
    return null;
}
