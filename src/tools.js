import { exec } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import ignore from 'ignore';

const execAsync = promisify(exec);
const INTERNAL_IGNORES = new Set(['.git']);
const MAX_TOOL_OUTPUT = 24000;
const USER_AGENT = 'OpenRouterCodeAgent/0.1 (+https://openrouter.ai)';

export function buildToolDefinitions({
    openRouterWebSearch = true,
    openRouterWebFetch = true,
    webSearchEngine,
    webSearchMaxResults,
    webSearchMaxTotalResults,
    webSearchContextSize,
    webFetchEngine,
    webFetchMaxUses,
    webFetchMaxContentTokens,
} = {}) {
    return [
        ...toolDefinitions,
        ...buildOpenRouterServerTools({
            openRouterWebSearch,
            openRouterWebFetch,
            webSearchEngine,
            webSearchMaxResults,
            webSearchMaxTotalResults,
            webSearchContextSize,
            webFetchEngine,
            webFetchMaxUses,
            webFetchMaxContentTokens,
        }),
    ];
}

export function buildOpenRouterServerTools({
    openRouterWebSearch = true,
    openRouterWebFetch = true,
    webSearchEngine,
    webSearchMaxResults,
    webSearchMaxTotalResults,
    webSearchContextSize,
    webFetchEngine,
    webFetchMaxUses,
    webFetchMaxContentTokens,
} = {}) {
    const tools = [];
    if (openRouterWebSearch) {
        tools.push({
            type: 'openrouter:web_search',
            parameters: removeUndefined({
                engine: webSearchEngine,
                max_results: webSearchMaxResults,
                max_total_results: webSearchMaxTotalResults,
                search_context_size: webSearchContextSize,
            }),
        });
    }
    if (openRouterWebFetch) {
        tools.push({
            type: 'openrouter:web_fetch',
            parameters: removeUndefined({
                engine: webFetchEngine,
                max_uses: webFetchMaxUses,
                max_content_tokens: webFetchMaxContentTokens,
            }),
        });
    }
    return tools;
}

// Permission classification for each tool. `read` tools never prompt; `edit`
// and `bash` tools are gated by src/permissions.js before runtime.execute runs.
export const TOOL_META = {
    Read: { readOnly: true, permission: 'read' },
    Glob: { readOnly: true, permission: 'read' },
    Grep: { readOnly: true, permission: 'read' },
    list_files: { readOnly: true, permission: 'read' },
    print_tree: { readOnly: true, permission: 'read' },
    TodoWrite: { readOnly: true, permission: 'read' },
    TodoRead: { readOnly: true, permission: 'read' },
    WebFetch: { readOnly: true, permission: 'read' },
    WebSearch: { readOnly: true, permission: 'read' },
    Write: { readOnly: false, permission: 'edit' },
    Edit: { readOnly: false, permission: 'edit' },
    Bash: { readOnly: false, permission: 'bash' },
};

export const toolDefinitions = [
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
            name: 'Read',
            description: 'Read a UTF-8 text file with optional line bounds.',
            parameters: {
                type: 'object',
                required: ['path'],
                properties: {
                    path: { type: 'string' },
                    start_line: { type: 'integer', minimum: 1 },
                    end_line: { type: 'integer', minimum: 1 },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Write',
            description: 'Create or overwrite a UTF-8 text file inside the workspace.',
            parameters: {
                type: 'object',
                required: ['path', 'content'],
                properties: {
                    path: { type: 'string' },
                    content: { type: 'string' },
                    overwrite: { type: 'boolean', default: false },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'Edit',
            description: 'Replace exact text in a UTF-8 text file. Use Read first.',
            parameters: {
                type: 'object',
                required: ['path', 'search', 'replace'],
                properties: {
                    path: { type: 'string' },
                    search: { type: 'string' },
                    replace: { type: 'string' },
                    replace_all: { type: 'boolean', default: false },
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
    {
        type: 'function',
        function: {
            name: 'Bash',
            description: 'Run a shell command in the workspace and return stdout/stderr.',
            parameters: {
                type: 'object',
                required: ['command'],
                properties: {
                    command: { type: 'string' },
                    timeout_ms: {
                        type: 'integer',
                        minimum: 1000,
                        maximum: 120000,
                        default: 30000,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'TodoWrite',
            description: 'Replace the current task todo list. Useful for multi-step coding work.',
            parameters: {
                type: 'object',
                required: ['todos'],
                properties: {
                    todos: {
                        type: 'array',
                        items: {
                            type: 'object',
                            required: ['content', 'status'],
                            properties: {
                                content: { type: 'string' },
                                status: {
                                    type: 'string',
                                    enum: ['pending', 'in_progress', 'completed'],
                                },
                            },
                        },
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'TodoRead',
            description: 'Read the current task todo list.',
            parameters: { type: 'object', properties: {} },
        },
    },
    {
        type: 'function',
        function: {
            name: 'WebFetch',
            description:
                'Fetch a URL and return extracted text. Use for docs, issues, and web pages.',
            parameters: {
                type: 'object',
                required: ['url'],
                properties: {
                    url: { type: 'string' },
                    max_chars: {
                        type: 'integer',
                        minimum: 1000,
                        maximum: 60000,
                        default: 16000,
                    },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'WebSearch',
            description:
                'Search the web. Uses Tavily when TAVILY_API_KEY is set, otherwise DuckDuckGo HTML best-effort.',
            parameters: {
                type: 'object',
                required: ['query'],
                properties: {
                    query: { type: 'string' },
                    allowed_domains: { type: 'array', items: { type: 'string' } },
                    blocked_domains: { type: 'array', items: { type: 'string' } },
                    max_results: { type: 'integer', minimum: 1, maximum: 20, default: 5 },
                },
            },
        },
    },
];

export function createToolRuntime({
    cwd = process.cwd(),
    additionalDirectories = [],
    allowOutsideCwd = false,
    onEvent = () => {},
} = {}) {
    const root = path.resolve(cwd);
    const extraRoots = additionalDirectories.map((dir) => path.resolve(root, dir));
    let todos = [];
    const ignoreMatcher = loadGitIgnoreMatcher(root);

    // Permission/hook gating happens in src/query.js before this runs; the
    // runtime is purely mechanical (matches how the SDK splits the loop from
    // the permission layer).
    async function execute(name, input = {}) {
        const args = input || {};
        onEvent({ type: 'tool_start', name, input: args });

        try {
            const result = await runTool(name, args);
            const content = truncate(formatResult(result), MAX_TOOL_OUTPUT);
            onEvent({ type: 'tool_end', name, ok: true, content });
            return { content, is_error: false };
        } catch (error) {
            const content = `ERROR: ${error.message}`;
            onEvent({ type: 'tool_end', name, ok: false, content });
            return { content, is_error: true };
        }
    }

    async function runTool(name, args) {
        if (name === 'list_files')
            return listFiles(resolvePath(args.path || '.'), args.max_depth ?? 3);
        if (name === 'Glob') return globFiles(resolvePath(args.path || '.'), args);
        if (name === 'print_tree') return printTree(resolvePath(args.path || '.'), args);
        if (name === 'Read') return readFile(resolvePath(args.path), args);
        if (name === 'Write') return writeFile(resolvePath(args.path), args);
        if (name === 'Edit') return editFile(resolvePath(args.path), args);
        if (name === 'Grep') return grepFiles(resolvePath(args.path || '.'), args);
        if (name === 'TodoWrite') return writeTodos(args.todos || []);
        if (name === 'TodoRead') return { todos };
        if (name === 'WebFetch') return webFetch(args);
        if (name === 'WebSearch') return webSearch(args);
        if (name === 'Bash') return runCommand(args.command, args.timeout_ms ?? 30000);
        throw new Error(`Unknown tool: ${name}`);
    }

    function resolvePath(target = '.') {
        const full = path.resolve(root, target);
        if (allowOutsideCwd) return full;
        if (full === root || full.startsWith(root + path.sep)) return full;
        if (extraRoots.some((dir) => full === dir || full.startsWith(dir + path.sep))) return full;
        throw new Error(`Path escapes workspace: ${target}`);
    }

    async function listFiles(dir, maxDepth) {
        const matcher = await ignoreMatcher;
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
        const matcher = await ignoreMatcher;
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
        const matcher = await ignoreMatcher;
        const re = globToRegExp(pattern);
        const files = [];
        await walkFiles(root, dir, matcher, async (full) => {
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (files.length < maxResults && re.test(rel)) files.push(rel);
        });
        return { pattern, files, truncated: files.length >= maxResults };
    }

    async function readFile(file, { start_line: startLine, end_line: endLine }) {
        const text = await fs.readFile(file, 'utf8');
        const lines = text.split(/\r?\n/);
        const start = Math.max((startLine || 1) - 1, 0);
        const end = Math.min(endLine || lines.length, lines.length);
        const numbered = lines
            .slice(start, end)
            .map((line, index) => `${start + index + 1}: ${line}`);
        return { path: path.relative(root, file), content: numbered.join('\n') };
    }

    async function writeFile(file, { content, overwrite = false }) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        if (!overwrite) {
            try {
                await fs.access(file);
                throw new Error('File exists. Pass overwrite=true to replace it.');
            } catch (error) {
                if (error.code !== 'ENOENT') throw error;
            }
        }
        await fs.writeFile(file, content ?? '', 'utf8');
        return {
            path: path.relative(root, file),
            bytes: Buffer.byteLength(content ?? '', 'utf8'),
        };
    }

    async function editFile(file, { search, replace, replace_all: replaceAll = false }) {
        if (!search) throw new Error('search must be non-empty');
        const before = await fs.readFile(file, 'utf8');
        const count = replaceAll
            ? before.split(search).length - 1
            : before.includes(search)
              ? 1
              : 0;
        if (!count) throw new Error('search text not found');
        const after = replaceAll
            ? before.split(search).join(replace ?? '')
            : before.replace(search, replace ?? '');
        await fs.writeFile(file, after, 'utf8');
        return { path: path.relative(root, file), replacements: count };
    }

    async function grepFiles(
        dir,
        { pattern, file_regex: fileRegex, max_results: maxResults = 50 }
    ) {
        const matcher = await ignoreMatcher;
        const re = new RegExp(pattern, 'i');
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
                text.split(/\r?\n/).forEach((line, index) => {
                    if (results.length < maxResults && re.test(line)) {
                        results.push({ path: rel, line: index + 1, text: line });
                    }
                });
            }
        }
        await walk(dir);
        return { matches: results, truncated: results.length >= maxResults };
    }

    function writeTodos(nextTodos) {
        const oldTodos = todos;
        todos = nextTodos.map((todo) => ({
            content: String(todo.content || ''),
            status: ['pending', 'in_progress', 'completed'].includes(todo.status)
                ? todo.status
                : 'pending',
        }));
        return { oldTodos, newTodos: todos };
    }

    async function webFetch({ url, max_chars: maxChars = 16000 }) {
        const target = parseHttpUrl(url);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
            const response = await fetch(target, {
                signal: controller.signal,
                headers: {
                    'user-agent': USER_AGENT,
                    accept: 'text/html,text/plain,application/json,*/*',
                },
            });
            const contentType = response.headers.get('content-type') || '';
            const raw = await response.text();
            const text = contentType.includes('html') ? htmlToText(raw) : raw;
            const title = contentType.includes('html') ? extractTitle(raw) : undefined;
            return {
                url: target,
                status: response.status,
                ok: response.ok,
                content_type: contentType,
                title,
                content: truncate(text.trim(), maxChars),
                truncated: text.trim().length > maxChars,
            };
        } finally {
            clearTimeout(timeout);
        }
    }

    async function webSearch({
        query,
        allowed_domains: allowedDomains = [],
        blocked_domains: blockedDomains = [],
        max_results: maxResults = 5,
    }) {
        if (!query) throw new Error('query is required');
        const limit = Math.min(Math.max(Number(maxResults) || 5, 1), 20);
        const results = process.env.TAVILY_API_KEY
            ? await tavilySearch(query, limit, allowedDomains, blockedDomains)
            : await duckDuckGoSearch(query, limit);
        const filtered = results
            .filter((result) => domainAllowed(result.url, allowedDomains, blockedDomains))
            .slice(0, limit);
        return {
            query,
            provider: process.env.TAVILY_API_KEY ? 'tavily' : 'duckduckgo-html',
            results: filtered,
        };
    }

    async function runCommand(command, timeoutMs) {
        const options = {
            cwd: root,
            timeout: timeoutMs,
            maxBuffer: 1024 * 1024 * 8,
            env: process.env,
            shell: true,
        };
        try {
            const { stdout, stderr } = await execAsync(command, options);
            return { command, exit_code: 0, stdout, stderr };
        } catch (error) {
            return {
                command,
                exit_code: typeof error.code === 'number' ? error.code : 1,
                stdout: error.stdout || '',
                stderr: error.stderr || '',
                error: error.killed ? `Command timed out after ${timeoutMs}ms` : error.message,
            };
        }
    }

    return { root, execute };
}

async function walkFiles(root, dir, matcher, visit) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (isIgnored(matcher, root, full, entry.isDirectory())) continue;
        if (entry.isDirectory()) await walkFiles(root, full, matcher, visit);
        else await visit(full);
    }
}

async function loadGitIgnoreMatcher(root) {
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

function isIgnored(matcher, root, fullPath, isDirectory = false) {
    const rel = normalizeRelative(root, fullPath);
    if (!rel) return false;
    return matcher.ignores(rel) || (isDirectory && matcher.ignores(`${rel}/`));
}

function normalizeRelative(root, fullPath) {
    const relative = path.relative(root, fullPath);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return '';
    return relative.split(path.sep).filter(Boolean).join('/');
}

function globToRegExp(pattern) {
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

async function tavilySearch(query, limit, allowedDomains = [], blockedDomains = []) {
    const response = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
            'user-agent': USER_AGENT,
        },
        body: JSON.stringify({
            query,
            max_results: limit,
            search_depth: process.env.TAVILY_SEARCH_DEPTH || 'basic',
            include_answer: false,
            include_raw_content: false,
            include_domains: allowedDomains,
            exclude_domains: blockedDomains,
        }),
    });
    const data = await response.json();
    if (!response.ok)
        throw new Error(
            `Tavily Search ${response.status}: ${
                data?.detail?.error || data?.detail || data?.error || response.statusText
            }`
        );
    return (data.results || []).map((item) => ({
        title: item.title,
        url: item.url,
        snippet: item.content,
        score: item.score,
    }));
}

async function duckDuckGoSearch(query, limit) {
    const url = new URL('https://duckduckgo.com/html/');
    url.searchParams.set('q', query);
    const response = await fetch(url, {
        headers: {
            accept: 'text/html',
            'user-agent': USER_AGENT,
        },
    });
    const html = await response.text();
    if (!response.ok) throw new Error(`DuckDuckGo ${response.status}: ${response.statusText}`);
    return parseDuckDuckGoHtml(html).slice(0, limit);
}

function parseDuckDuckGoHtml(html) {
    const results = [];
    const blocks = html.split(/<div class="result results_links[^"]*"/i).slice(1);
    for (const block of blocks) {
        const linkMatch = block.match(
            /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i
        );
        if (!linkMatch) continue;
        const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i);
        results.push({
            title: htmlDecode(stripTags(linkMatch[2])).trim(),
            url: unwrapDuckDuckGoUrl(htmlDecode(linkMatch[1])),
            snippet: htmlDecode(stripTags(snippetMatch?.[1] || '')).trim(),
        });
    }
    return results;
}

function unwrapDuckDuckGoUrl(value) {
    try {
        const url = value.startsWith('//') ? new URL(`https:${value}`) : new URL(value);
        const uddg = url.searchParams.get('uddg');
        return uddg || value;
    } catch {
        return value;
    }
}

function parseHttpUrl(url) {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol))
        throw new Error('Only http/https URLs are supported');
    return parsed.toString();
}

function domainAllowed(url, allowedDomains, blockedDomains) {
    let host;
    try {
        host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return false;
    }
    const allowed = allowedDomains.map((domain) => domain.replace(/^www\./, ''));
    const blocked = blockedDomains.map((domain) => domain.replace(/^www\./, ''));
    if (allowed.length && !allowed.some((domain) => host === domain || host.endsWith(`.${domain}`)))
        return false;
    return !blocked.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function extractTitle(html) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? htmlDecode(stripTags(match[1])).trim() : undefined;
}

function htmlToText(html) {
    return htmlDecode(
        html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/(p|div|section|article|li|h[1-6])>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .replace(/[ \t]{2,}/g, ' ')
    );
}

function stripTags(value) {
    return value.replace(/<[^>]+>/g, ' ');
}

function htmlDecode(value) {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&nbsp;/g, ' ');
}

function formatResult(value) {
    return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function truncate(text, max) {
    if (text.length <= max) return text;
    return `${text.slice(0, max)}\n[truncated ${text.length - max} chars]`;
}

function escapeRegExp(value) {
    return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function removeUndefined(value) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}
