import { promises as fs } from 'node:fs';
import path from 'node:path';
import { walkFiles } from './search.js';

// Orientation tools that run BEFORE grepping, so the agent investigates
// top-down instead of pattern-matching the issue text straight into Grep:
//   CodebaseMap — one-call structural overview of the workspace.
//   TraceDeps   — what a file imports, and (reverse) what depends on it.
// Both are read-only and never prompt (see tools/meta.js).

const MANIFESTS = [
    'package.json', 'requirements.txt', 'pyproject.toml', 'go.mod', 'Cargo.toml',
    'pom.xml', 'build.gradle', 'Gemfile', 'composer.json',
];
const KEY_FILES = [
    'README.md', 'README', 'tsconfig.json', 'Dockerfile', 'docker-compose.yml',
    'Makefile', '.env.example',
];
const ENTRY_RE = /^(index|main|app|server|cli)\.(js|mjs|cjs|ts|tsx|py|go|rs)$/;
const IMPORT_EXTS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.json', '.py', '.go'];

const IMPORT_PATTERNS = [
    /import\s+[\s\S]*?from\s*['"]([^'"]+)['"]/g, // import x from 'y'
    /import\s*['"]([^'"]+)['"]/g, // import 'y'
    /export\s+[\s\S]*?from\s*['"]([^'"]+)['"]/g, // export … from 'y'
    /require\(\s*['"]([^'"]+)['"]\s*\)/g, // require('y')
    /import\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('y')
    /(?:^|\n)\s*from\s+([A-Za-z0-9_.]+)\s+import\s/g, // python: from y import
    /(?:^|\n)\s*import\s+([A-Za-z0-9_.]+)/g, // python: import y
];

export const codebaseToolDefinitions = [
    {
        type: 'function',
        function: {
            name: 'CodebaseMap',
            description:
                'One-call structural overview of the workspace: languages, package manifests + dependencies, entry points, key files, and top-level layout with file counts. Run this FIRST on an unfamiliar codebase or bug — orient top-down before grepping.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Workspace-relative directory. Default: .' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'TraceDeps',
            description:
                'Trace a file’s dependencies. Default: list what the file imports (internal workspace files vs external packages). With reverse=true: list the files that import this one (its dependents) — use it before editing to avoid breaking callers.',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string', description: 'Workspace-relative file path.' },
                    reverse: { type: 'boolean', default: false },
                    max_results: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'TraceCalls',
            description:
                'Trace the execution path of a function/symbol (heuristic regex call graph). Default direction "callers": who calls it, and who calls them, up to depth — i.e. how execution reaches it. direction "callees": what the function itself calls. Use it to understand how a buggy line is reached before changing it.',
            parameters: {
                type: 'object',
                required: ['symbol'],
                properties: {
                    symbol: { type: 'string', description: 'Function or method name.' },
                    direction: { type: 'string', enum: ['callers', 'callees'], default: 'callers' },
                    depth: { type: 'integer', minimum: 1, maximum: 5, default: 3 },
                    max_per_level: { type: 'integer', minimum: 1, maximum: 100, default: 25 },
                },
            },
        },
    },
];

export function createCodebaseHandlers({ root, resolvePath, getMatcher }) {
    const rel = (p) => path.relative(root, p).split(path.sep).join('/');

    return {
        CodebaseMap: (args) => map(resolvePath(args.path || '.')),
        TraceDeps: (args) =>
            args.reverse
                ? reverseTrace(resolvePath(args.path), args.max_results ?? 50)
                : forwardTrace(resolvePath(args.path)),
        TraceCalls: (args) =>
            traceCalls(args.symbol, args.direction || 'callers', args.depth ?? 3, args.max_per_level ?? 25),
    };

    async function map(dir) {
        const matcher = await getMatcher();
        const extensions = {};
        const topLevel = {};
        const manifests = [];
        const keyFiles = [];
        const entryPoints = new Set();
        let total = 0;

        await walkFiles(root, dir, matcher, (full) => {
            total += 1;
            const ext = path.extname(full).toLowerCase() || '(none)';
            extensions[ext] = (extensions[ext] || 0) + 1;
            const parts = path.relative(dir, full).split(path.sep);
            const seg = parts.length > 1 ? `${parts[0]}/` : '(root)';
            topLevel[seg] = (topLevel[seg] || 0) + 1;
            const name = path.basename(full);
            if (MANIFESTS.includes(name)) manifests.push(rel(full));
            if (KEY_FILES.includes(name)) keyFiles.push(rel(full));
            if (parts.length <= 2 && ENTRY_RE.test(name)) entryPoints.add(rel(full));
        });

        const pkg = await readPackageJson(path.join(root, 'package.json'));
        if (pkg?.main) entryPoints.add(pkg.main);
        for (const binPath of binPaths(pkg?.bin)) entryPoints.add(binPath);

        return {
            root,
            total_files: total,
            languages: topEntries(extensions, 12),
            top_level: topEntries(topLevel, 20),
            manifests,
            key_files: keyFiles,
            package: pkg,
            entry_points: [...entryPoints],
            hint: 'Before grepping: write 2-3 candidate root causes to TodoWrite, then use Grep/TraceDeps to confirm or refute each.',
        };
    }

    async function forwardTrace(file) {
        const text = await fs.readFile(file, 'utf8');
        const internal = new Set();
        const external = new Set();
        for (const spec of extractImports(text)) {
            if (spec.startsWith('.') || spec.startsWith('/')) {
                const resolved = await resolveImport(path.dirname(file), spec);
                internal.add(resolved ? rel(resolved) : `${spec} (unresolved)`);
            } else {
                external.add(spec);
            }
        }
        return {
            path: rel(file),
            imports_internal: [...internal],
            imports_external: [...external],
        };
    }

    async function reverseTrace(target, maxResults) {
        const matcher = await getMatcher();
        const stem = path.basename(target).replace(/\.[^.]+$/, '');
        const dependents = [];
        await walkFiles(root, root, matcher, async (full) => {
            if (dependents.length >= maxResults || full === target) return;
            let text;
            try {
                text = await fs.readFile(full, 'utf8');
            } catch {
                return;
            }
            if (!text.includes(stem)) return; // cheap pre-filter, like a literal grep
            for (const spec of extractImports(text)) {
                if (!spec.startsWith('.')) continue;
                if ((await resolveImport(path.dirname(full), spec)) === target) {
                    dependents.push(rel(full));
                    break;
                }
            }
        });
        return {
            path: rel(target),
            depended_on_by: dependents,
            truncated: dependents.length >= maxResults,
        };
    }

    async function resolveImport(fromDir, spec) {
        const base = path.resolve(fromDir, spec);
        const direct = await statFile(base);
        if (direct?.isFile()) return base;
        for (const ext of IMPORT_EXTS) {
            if ((await statFile(base + ext))?.isFile()) return base + ext;
        }
        if (direct?.isDirectory()) {
            for (const ext of IMPORT_EXTS) {
                const idx = path.join(base, `index${ext}`);
                if ((await statFile(idx))?.isFile()) return idx;
            }
        }
        return null;
    }

    async function traceCalls(symbol, direction, depth, maxPerLevel) {
        const matcher = await getMatcher();
        const definitions = await findDefs(symbol, matcher, maxPerLevel);
        if (direction === 'callees') {
            return { symbol, definitions, callees: await findCallees(symbol, definitions) };
        }
        const { callers } = await callerTree(symbol, depth, maxPerLevel, matcher, new Set());
        return {
            symbol,
            definitions,
            callers,
            note: 'Heuristic regex call graph — verify by reading the listed sites.',
        };
    }

    async function findDefs(symbol, matcher, max) {
        const re = defRe(symbol);
        const hits = [];
        await walkFiles(root, root, matcher, (full) => scanLines(full, symbol, hits, max, (line) => re.test(line)));
        return hits;
    }

    async function callerTree(symbol, depth, max, matcher, visited) {
        if (visited.has(symbol)) return { callers: [{ caller: symbol, cyclic: true }] };
        visited.add(symbol);
        const cre = callRe(symbol);
        const dre = defRe(symbol);
        const groups = new Map();
        await walkFiles(root, root, matcher, async (full) => {
            let text;
            try {
                text = await fs.readFile(full, 'utf8');
            } catch {
                return;
            }
            if (!text.includes(symbol)) return;
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length; i += 1) {
                if (!cre.test(lines[i]) || dre.test(lines[i])) continue;
                const enclosing = enclosingName(lines, i);
                if (!groups.has(enclosing)) groups.set(enclosing, []);
                if (groups.get(enclosing).length < max) groups.get(enclosing).push(`${rel(full)}:${i + 1}`);
            }
        });

        const callers = [];
        for (const [caller, at] of groups) {
            const node = { caller, at };
            if (depth > 1 && caller !== TOP_LEVEL) {
                const sub = await callerTree(caller, depth - 1, max, matcher, visited);
                if (sub.callers.length) node.callers = sub.callers;
            }
            callers.push(node);
        }
        return { callers };
    }

    async function findCallees(symbol, definitions) {
        if (!definitions.length) return [];
        const [file, lineStr] = definitions[0].split(':');
        let text;
        try {
            text = await fs.readFile(path.join(root, file), 'utf8');
        } catch {
            return [];
        }
        const lines = text.split(/\r?\n/);
        const body = sliceBlock(lines, Number(lineStr) - 1).join('\n');
        const names = new Set();
        const re = new RegExp(`\\b(${ID})\\s*\\(`, 'g');
        let match;
        while ((match = re.exec(body))) {
            if (match[1] !== symbol && !KEYWORDS.has(match[1])) names.add(match[1]);
        }
        return [...names].slice(0, 40);
    }

    async function scanLines(full, symbol, hits, max, test) {
        if (hits.length >= max) return;
        let text;
        try {
            text = await fs.readFile(full, 'utf8');
        } catch {
            return;
        }
        if (!text.includes(symbol)) return;
        text.split(/\r?\n/).forEach((line, i) => {
            if (hits.length < max && test(line)) hits.push(`${rel(full)}:${i + 1}`);
        });
    }
}

const ID = '[A-Za-z0-9_$]+';
const TOP_LEVEL = '(top-level)';
const KEYWORDS = new Set([
    'if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'typeof',
    'await', 'async', 'new', 'do', 'else', 'super', 'import', 'require',
]);
const ENCLOSING_RE = new RegExp(
    `function\\s+(${ID})` +
        `|(?:const|let|var)\\s+(${ID})\\s*=\\s*(?:async\\s*)?(?:function|\\()` +
        `|(${ID})\\s*[:=]\\s*(?:async\\s*)?(?:function|\\()` +
        `|def\\s+(${ID})` +
        `|(${ID})\\s*\\([^)]*\\)\\s*\\{`
);

function escapeRe(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function defRe(symbol) {
    const s = escapeRe(symbol);
    return new RegExp(
        `function\\s+${s}\\b|(?:const|let|var)\\s+${s}\\s*=|\\b${s}\\s*[:=]\\s*(?:async\\s*)?function\\b|\\bdef\\s+${s}\\b|class\\s+${s}\\b`
    );
}

function callRe(symbol) {
    return new RegExp(`\\b${escapeRe(symbol)}\\s*\\(`);
}

function enclosingName(lines, idx) {
    for (let i = idx; i >= 0; i -= 1) {
        const match = ENCLOSING_RE.exec(lines[i]);
        if (match) return match[1] || match[2] || match[3] || match[4] || match[5];
    }
    return TOP_LEVEL;
}

// Collect a function body by brace balance (JS), falling back to ~60 lines
// when no brace is found (e.g. Python).
function sliceBlock(lines, start) {
    const out = [];
    let depth = 0;
    let seenBrace = false;
    for (let i = start; i < lines.length && i < start + 200; i += 1) {
        out.push(lines[i]);
        for (const ch of lines[i]) {
            if (ch === '{') {
                depth += 1;
                seenBrace = true;
            } else if (ch === '}') depth -= 1;
        }
        if (seenBrace && depth <= 0) break;
        if (!seenBrace && out.length >= 60) break;
    }
    return out;
}

function extractImports(text) {
    const specs = new Set();
    for (const pattern of IMPORT_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text))) specs.add(match[1]);
    }
    return [...specs];
}

async function statFile(target) {
    try {
        return await fs.stat(target);
    } catch {
        return null;
    }
}

async function readPackageJson(file) {
    try {
        const pkg = JSON.parse(await fs.readFile(file, 'utf8'));
        return {
            name: pkg.name,
            scripts: Object.keys(pkg.scripts || {}),
            dependencies: Object.keys(pkg.dependencies || {}),
            devDependencies: Object.keys(pkg.devDependencies || {}),
            main: pkg.main,
            bin: pkg.bin,
        };
    } catch {
        return undefined;
    }
}

function binPaths(bin) {
    if (!bin) return [];
    return typeof bin === 'string' ? [bin] : Object.values(bin);
}

function topEntries(counts, limit) {
    return Object.fromEntries(
        Object.entries(counts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, limit)
    );
}
