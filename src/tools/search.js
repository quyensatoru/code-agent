import { promises as fs } from 'node:fs';
import path from 'node:path';
import ignore from 'ignore';

// File discovery and content search tools: list_files, print_tree, Glob, Grep.
// All of them respect .gitignore files at the workspace root and in
// subdirectories; `.git/` is always skipped.

const INTERNAL_IGNORES = new Set(['.git']);

export const searchToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'list_files',
            description: 'List files under a workspace-relative directory.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Workspace-relative directory. Default: .',
                    },
                    max_depth: { type: 'integer', minimum: 0, maximum: 8, default: 3 },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Glob',
            description: 'Find files by a glob pattern such as **/*.js or src/**/*.{ts,tsx}.',
            parameters: {
                type: 'object',
                required: ['pattern'],
                properties: {
                    pattern: { type: 'string' },
                    path: {
                        type: 'string',
                        description: 'Workspace-relative directory. Default: .',
                    },
                    max_results: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 1000,
                        default: 200,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'print_tree',
            description: 'Print a directory tree under a workspace-relative path.',
            parameters: {
                type: 'object',
                properties: {
                    path: {
                        type: 'string',
                        description: 'Workspace-relative directory. Default: .',
                    },
                    depth: { type: 'integer', minimum: 0, maximum: 8, default: 3 },
                    max_entries: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 1000,
                        default: 300,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Grep',
            description: 'Search text files by JavaScript regex under a workspace-relative path.',
            parameters: {
                type: 'object',
                required: ['pattern'],
                properties: {
                    pattern: { type: 'string' },
                    path: { type: 'string', default: '.' },
                    file_regex: {
                        type: 'string',
                        description: 'Optional regex applied to relative file paths.',
                    },
                    case_sensitive: { type: 'boolean', default: false },
                    context: {
                        type: 'integer',
                        minimum: 0,
                        maximum: 5,
                        default: 0,
                        description: 'Lines of context to include before/after each match.',
                    },
                    max_results: {
                        type: 'integer',
                        minimum: 1,
                        maximum: 200,
                        default: 50,
                    },
                },
            },
        },
    },
];

export function createSearchHandlers({ root, resolvePath, getMatcher }) {
    return {
        list_files: (args) => listFiles(resolvePath(args.path || '.'), args.max_depth ?? 3),
        Glob: (args) => globFiles(resolvePath(args.path || '.'), args),
        print_tree: (args) => printTree(resolvePath(args.path || '.'), args),
        Grep: (args) => grepFiles(resolvePath(args.path || '.'), args),
    };

    async function listFiles(dir, maxDepth) {
        const matcher = await getMatcher();
        const out = [];
        async function walk(current, depth) {
            if (depth > maxDepth) return;
            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (isIgnored(matcher, root, full, entry.isDirectory())) continue;
                const rel = path.relative(root, full) || '.';
                out.push(entry.isDirectory() ? `${rel}/` : rel);
                if (entry.isDirectory()) await walk(full, depth + 1);
            }
        }
        await walk(dir, 0);
        return { root, files: out.slice(0, 500), truncated: out.length > 500 };
    }

    async function printTree(dir, { depth = 3, max_entries: maxEntries = 300 }) {
        const matcher = await getMatcher();
        const rootLabel = path.relative(root, dir) || '.';
        const lines = [`${rootLabel}/`];
        let count = 0;
        let truncated = false;

        async function walk(current, currentDepth, prefix) {
            if (currentDepth >= depth || truncated) return;
            const entries = await fs.readdir(current, { withFileTypes: true });
            const visible = entries
                .filter((entry) => {
                    const full = path.join(current, entry.name);
                    return !isIgnored(matcher, root, full, entry.isDirectory());
                })
                .sort((a, b) => {
                    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
                    return a.name.localeCompare(b.name);
                });

            for (let index = 0; index < visible.length; index += 1) {
                if (count >= maxEntries) {
                    truncated = true;
                    return;
                }
                const entry = visible[index];
                const full = path.join(current, entry.name);
                const isLast = index === visible.length - 1;
                const connector = isLast ? '└── ' : '├── ';
                lines.push(`${prefix}${connector}${entry.name}${entry.isDirectory() ? '/' : ''}`);
                count += 1;
                if (entry.isDirectory()) {
                    await walk(full, currentDepth + 1, `${prefix}${isLast ? '    ' : '│   '}`);
                }
            }
        }

        await walk(dir, 0, '');
        if (truncated) lines.push(`[truncated after ${maxEntries} entries]`);
        return lines.join('\n');
    }

    async function globFiles(dir, { pattern, max_results: maxResults = 200 }) {
        if (!pattern) throw new Error('pattern is required');
        const matcher = await getMatcher();
        const re = globToRegExp(pattern);
        const files = [];
        await walkFiles(root, dir, matcher, async (full) => {
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (files.length < maxResults && re.test(rel)) files.push(rel);
        });
        return { pattern, files, truncated: files.length >= maxResults };
    }

    async function grepFiles(
        dir,
        {
            pattern,
            file_regex: fileRegex,
            case_sensitive: caseSensitive = false,
            context = 0,
            max_results: maxResults = 50,
        }
    ) {
        const matcher = await getMatcher();
        let re;
        try {
            re = new RegExp(pattern, caseSensitive ? '' : 'i');
        } catch (error) {
            throw new Error(`Invalid regex pattern: ${error.message}`);
        }
        const fileRe = fileRegex ? new RegExp(fileRegex) : null;
        const results = [];
        async function walk(current) {
            if (results.length >= maxResults) return;
            const entries = await fs.readdir(current, { withFileTypes: true });
            for (const entry of entries) {
                const full = path.join(current, entry.name);
                if (
                    results.length >= maxResults ||
                    isIgnored(matcher, root, full, entry.isDirectory())
                )
                    continue;
                const rel = path.relative(root, full);
                if (entry.isDirectory()) {
                    await walk(full);
                    continue;
                }
                if (fileRe && !fileRe.test(rel)) continue;
                let text;
                try {
                    text = await fs.readFile(full, 'utf8');
                } catch {
                    continue;
                }
                const lines = text.split(/\r?\n/);
                lines.forEach((line, index) => {
                    if (results.length >= maxResults || !re.test(line)) return;
                    const match = { path: rel, line: index + 1, text: line };
                    if (context > 0) {
                        match.before = lines.slice(Math.max(index - context, 0), index);
                        match.after = lines.slice(index + 1, index + 1 + context);
                    }
                    results.push(match);
                });
            }
        }
        await walk(dir);
        return { matches: results, truncated: results.length >= maxResults };
    }
}

export async function walkFiles(root, dir, matcher, visit) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (isIgnored(matcher, root, full, entry.isDirectory())) continue;
        if (entry.isDirectory()) await walkFiles(root, full, matcher, visit);
        else await visit(full);
    }
}

export async function loadGitIgnoreMatcher(root) {
    const matcher = ignore();
    matcher.add('.git/');

    async function scan(dir) {
        const relDir = normalizeRelative(root, dir);
        await addGitIgnoreFile(matcher, relDir, path.join(dir, '.gitignore'));

        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory() || INTERNAL_IGNORES.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (isIgnored(matcher, root, full, true)) continue;
            await scan(full);
        }
    }

    await scan(root);
    return matcher;
}

async function addGitIgnoreFile(matcher, relDir, filePath) {
    let text;
    try {
        text = await fs.readFile(filePath, 'utf8');
    } catch (error) {
        if (error.code === 'ENOENT') return;
        throw error;
    }

    const patterns = [];
    for (const rawLine of text.split(/\n/)) {
        patterns.push(...normalizeGitIgnorePattern(rawLine.replace(/\r$/, ''), relDir));
    }
    if (patterns.length) matcher.add(patterns);
}

function normalizeGitIgnorePattern(line, relDir) {
    if (!line.trim() || line.startsWith('#')) return [];

    let negated = false;
    let pattern = line;
    if (pattern.startsWith('!')) {
        negated = true;
        pattern = pattern.slice(1);
    } else if (pattern.startsWith('\\#') || pattern.startsWith('\\!')) {
        pattern = pattern.slice(1);
    }

    if (!relDir) return [`${negated ? '!' : ''}${pattern}`];

    const anchored = pattern.startsWith('/');
    pattern = pattern.replace(/^\/+/, '');
    const prefix = relDir.endsWith('/') ? relDir : `${relDir}/`;
    const sign = negated ? '!' : '';

    if (anchored || pattern.includes('/')) return [`${sign}${prefix}${pattern}`];
    return [`${sign}${prefix}${pattern}`, `${sign}${prefix}**/${pattern}`];
}

export function isIgnored(matcher, root, fullPath, isDirectory = false) {
    const rel = normalizeRelative(root, fullPath);
    if (!rel) return false;
    return matcher.ignores(rel) || (isDirectory && matcher.ignores(`${rel}/`));
}

function normalizeRelative(root, fullPath) {
    const relative = path.relative(root, fullPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return relative.split(path.sep).filter(Boolean).join('/');
}

export function globToRegExp(pattern) {
    const input = pattern.split(path.sep).join('/');
    let out = '^';
    for (let index = 0; index < input.length; index += 1) {
        const char = input[index];
        const next = input[index + 1];
        const afterNext = input[index + 2];
        if (char === '*' && next === '*' && afterNext === '/') {
            out += '(?:.*/)?';
            index += 2;
        } else if (char === '*' && next === '*') {
            out += '.*';
            index += 1;
        } else if (char === '*') out += '[^/]*';
        else if (char === '?') out += '[^/]';
        else if (char === '{') {
            const end = input.indexOf('}', index);
            if (end === -1) out += '\\{';
            else {
                const parts = input
                    .slice(index + 1, end)
                    .split(',')
                    .map((part) => escapeRegExp(part));
                out += `(${parts.join('|')})`;
                index = end;
            }
        } else out += escapeRegExp(char);
    }
    out += '$';
    return new RegExp(out);
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}
