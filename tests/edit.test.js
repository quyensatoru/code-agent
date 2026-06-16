import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';
import { validateInput } from '../src/tools/validate.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'oragent-edit-'));
const EDIT_SCHEMA = {
    type: 'object',
    required: ['path', 'search', 'replace'],
    properties: { path: { type: 'string' }, search: { type: 'string' }, replace: { type: 'string' } },
};

test('empty string counts as present for a required field (Edit replace="")', () => {
    const { errors } = validateInput(EDIT_SCHEMA, { path: 'a', search: 'x', replace: '' });
    assert.deepEqual(errors, []);
});

test('Edit deletes text with replace="" instead of looping on INVALID INPUT', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'a.js'), 'keep\nremove me\nkeep\n');
    const runtime = createToolRuntime({ cwd: dir });
    const result = await runtime.execute('Edit', { path: 'a.js', search: 'remove me\n', replace: '' });
    assert.equal(result.is_error, false);
    assert.equal(readFileSync(path.join(dir, 'a.js'), 'utf8'), 'keep\nkeep\n');
});

test('Edit matches a CRLF file when the model sends LF search text', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'win.js'), 'const a = 1;\r\nconst b = 2;\r\n');
    const runtime = createToolRuntime({ cwd: dir });
    const result = await runtime.execute('Edit', {
        path: 'win.js',
        search: 'const a = 1;\nconst b = 2;', // LF, file is CRLF
        replace: 'const x = 9;',
    });
    assert.equal(result.is_error, false);
    const after = readFileSync(path.join(dir, 'win.js'), 'utf8');
    assert.match(after, /const x = 9;/);
    assert.doesNotMatch(after, /const a = 1;/);
});

test('Edit inserts replacement text literally (no $-pattern interpretation)', async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'p.js'), 'const price = AMOUNT;\n');
    const runtime = createToolRuntime({ cwd: dir });
    const result = await runtime.execute('Edit', { path: 'p.js', search: 'AMOUNT', replace: '"$&$1"' });
    assert.equal(result.is_error, false);
    assert.match(readFileSync(path.join(dir, 'p.js'), 'utf8'), /const price = "\$&\$1";/);
});
