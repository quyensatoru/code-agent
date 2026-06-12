import { promises as fs } from 'node:fs';
import path from 'node:path';

// Persistent, file-based agent memory (the same pattern Claude Code uses):
// a workspace-local directory where each memory is a small markdown file and
// MEMORY.md is the index loaded into the system prompt every session. The
// agent reads/writes memories with its ordinary Write/Edit tools — no special
// tool needed — so memory survives across sessions and is user-inspectable.

export const MEMORY_DIR = '.oragent/memory';
const MAX_INDEX_CHARS = 8000;

export async function loadMemoryIndex(cwd) {
    try {
        return await fs.readFile(path.join(cwd, MEMORY_DIR, 'MEMORY.md'), 'utf8');
    } catch {
        return null;
    }
}

export function memorySection(indexText) {
    const lines = [
        '# Memory',
        `You have a persistent, file-based memory directory at ${MEMORY_DIR}/ (workspace-relative).`,
        `- ${MEMORY_DIR}/MEMORY.md is the index: one line per memory file, e.g. \`- [title](file.md) — hook\`.`,
        '- To remember a durable fact, user preference, or project decision across sessions: Write a small markdown file in that directory (one fact per file) and add/update its line in MEMORY.md.',
        '- Update or delete memories that turn out to be wrong or stale.',
        '- Do not store secrets (keys, tokens, passwords) or anything derivable from the code itself.',
    ];
    if (indexText && indexText.trim()) {
        const body =
            indexText.length > MAX_INDEX_CHARS
                ? `${indexText.slice(0, MAX_INDEX_CHARS)}\n[truncated]`
                : indexText;
        lines.push('', 'Current MEMORY.md index:', '```markdown', body.trim(), '```');
    } else {
        lines.push('', '(memory is empty — create MEMORY.md on first write)');
    }
    return lines.join('\n');
}
