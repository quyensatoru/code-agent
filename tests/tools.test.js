import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime, mcpToolDefinitions } from '../src/tools/index.js';
import { globToRegExp } from '../src/tools/search.js';

function makeWorkspace() {
    const dir = mkdtempSync(path.join(tmpdir(), 'oragent-test-'));
    writeFileSync(path.join(dir, 'a.js'), 'const x = 1;\nconst y = 2;\nconst x2 = 1;\n');
    writeFileSync(path.join(dir, 'b.txt'), 'hello world\n');
    return dir;
}

test('runtime rejects paths escaping the workspace', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('Read', { path: '../../etc/passwd' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /escapes workspace/);
});

test('runtime validates input against the schema before running', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('Read', {});
    assert.equal(result.is_error, true);
    assert.match(result.content, /INVALID INPUT for Read/);
    assert.match(result.content, /required parameter "path"/);
});

test('runtime coerces numeric strings', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('Read', { path: 'a.js', start_line: '2', end_line: '2' });
    assert.equal(result.is_error, false);
    assert.match(result.content, /2: const y = 2;/);
});

test('unknown tool errors list available tools', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('Nope', {});
    assert.equal(result.is_error, true);
    assert.match(result.content, /Unknown tool "Nope"/);
    assert.match(result.content, /Read/);
});

test('Edit refuses ambiguous search text without replace_all', async () => {
    const dir = makeWorkspace();
    const runtime = createToolRuntime({ cwd: dir });
    const ambiguous = await runtime.execute('Edit', {
        path: 'a.js',
        search: '= 1;',
        replace: '= 9;',
    });
    assert.equal(ambiguous.is_error, true);
    assert.match(ambiguous.content, /appears 2 times/);

    const all = await runtime.execute('Edit', {
        path: 'a.js',
        search: '= 1;',
        replace: '= 9;',
        replace_all: true,
    });
    assert.equal(all.is_error, false);
    assert.match(readFileSync(path.join(dir, 'a.js'), 'utf8'), /const x = 9;/);
});

test('Write refuses to overwrite without overwrite=true', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('Write', { path: 'a.js', content: 'x' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /overwrite=true/);
});

test('Glob matches extension patterns', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('Glob', { pattern: '**/*.js' });
    assert.equal(result.is_error, false);
    assert.match(result.content, /a\.js/);
    assert.doesNotMatch(result.content, /b\.txt/);
});

test('globToRegExp handles ** and braces', () => {
    assert.ok(globToRegExp('**/*.js').test('src/deep/file.js'));
    assert.ok(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b.tsx'));
    assert.ok(!globToRegExp('*.js').test('src/file.js'));
});

test('mcp sdk-server tools are routed and normalized', async () => {
    const mcpServers = {
        calc: {
            type: 'sdk',
            name: 'calc',
            instance: {
                tools: [
                    {
                        name: 'add',
                        description: 'Add two numbers',
                        inputSchema: {
                            type: 'object',
                            required: ['a', 'b'],
                            properties: { a: { type: 'number' }, b: { type: 'number' } },
                        },
                        handler: async ({ a, b }) => ({
                            content: [{ type: 'text', text: String(a + b) }],
                        }),
                    },
                ],
            },
        },
    };
    const defs = mcpToolDefinitions(mcpServers);
    assert.equal(defs[0].function.name, 'mcp__calc__add');

    const runtime = createToolRuntime({ cwd: makeWorkspace(), mcpServers });
    const result = await runtime.execute('mcp__calc__add', { a: '2', b: 3 });
    assert.equal(result.is_error, false);
    assert.equal(result.content, '5');
});

test('TodoWrite keeps only one in_progress item', async () => {
    const runtime = createToolRuntime({ cwd: makeWorkspace() });
    const result = await runtime.execute('TodoWrite', {
        todos: [
            { content: 'one', status: 'in_progress' },
            { content: 'two', status: 'in_progress' },
        ],
    });
    assert.equal(result.is_error, false);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.newTodos[0].status, 'in_progress');
    assert.equal(parsed.newTodos[1].status, 'pending');
    assert.ok(parsed.note);
});
