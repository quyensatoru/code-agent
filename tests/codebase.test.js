import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';

function makeProject() {
    const dir = mkdtempSync(path.join(tmpdir(), 'oragent-cb-'));
    mkdirSync(path.join(dir, 'src'));
    writeFileSync(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'demo', main: 'src/index.js', scripts: { test: 'node --test' }, dependencies: { express: '^5' } })
    );
    writeFileSync(path.join(dir, 'README.md'), '# Demo');
    writeFileSync(path.join(dir, 'src', 'index.js'), "import { helper } from './util.js';\nimport express from 'express';\nhelper();\n");
    writeFileSync(path.join(dir, 'src', 'util.js'), 'export function helper() {}\n');
    writeFileSync(path.join(dir, 'src', 'other.js'), "import { helper } from './util.js';\n");
    return dir;
}

test('CodebaseMap reports structure, manifest deps, and entry points', async () => {
    const runtime = createToolRuntime({ cwd: makeProject() });
    const result = await runtime.execute('CodebaseMap', {});
    assert.equal(result.is_error, false);
    const map = JSON.parse(result.content);
    assert.equal(map.package.name, 'demo');
    assert.deepEqual(map.package.dependencies, ['express']);
    assert.ok(map.entry_points.includes('src/index.js'));
    assert.ok(map.key_files.includes('README.md'));
    assert.ok(map.languages['.js'] >= 3);
    assert.ok(map.hint.includes('TodoWrite'));
});

test('TraceDeps forward separates internal files from external packages', async () => {
    const runtime = createToolRuntime({ cwd: makeProject() });
    const result = await runtime.execute('TraceDeps', { path: 'src/index.js' });
    assert.equal(result.is_error, false);
    const deps = JSON.parse(result.content);
    assert.ok(deps.imports_internal.includes('src/util.js'));
    assert.ok(deps.imports_external.includes('express'));
});

test('TraceDeps reverse finds dependents of a file', async () => {
    const runtime = createToolRuntime({ cwd: makeProject() });
    const result = await runtime.execute('TraceDeps', { path: 'src/util.js', reverse: true });
    assert.equal(result.is_error, false);
    const deps = JSON.parse(result.content);
    assert.deepEqual(deps.depended_on_by.sort(), ['src/index.js', 'src/other.js']);
});

test('CodebaseMap and TraceDeps are read-class (no permission prompt)', async () => {
    const { TOOL_META } = await import('../src/tools/meta.js');
    assert.equal(TOOL_META.CodebaseMap.permission, 'read');
    assert.equal(TOOL_META.TraceDeps.permission, 'read');
});
