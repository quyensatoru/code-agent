import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';

function makeGitWorkspace() {
    const dir = mkdtempSync(path.join(tmpdir(), 'oragent-git-'));
    execFileSync('git', ['init', '-q'], { cwd: dir });
    writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    return dir;
}

test('Git tool runs read-only subcommands', async () => {
    const runtime = createToolRuntime({ cwd: makeGitWorkspace() });
    const result = await runtime.execute('Git', { subcommand: 'status' });
    assert.equal(result.is_error, false);
    assert.match(result.content, /a\.txt/);
});

test('Git tool rejects unsupported subcommands via schema enum', async () => {
    const runtime = createToolRuntime({ cwd: makeGitWorkspace() });
    const result = await runtime.execute('Git', { subcommand: 'push' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /INVALID INPUT/);
});

test('Git tool restricts stash to "stash list"', async () => {
    const runtime = createToolRuntime({ cwd: makeGitWorkspace() });
    const result = await runtime.execute('Git', { subcommand: 'stash', args: 'pop' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /stash list/);
});

test('RunCode executes node scripts in isolation', async () => {
    const runtime = createToolRuntime({ cwd: mkdtempSync(path.join(tmpdir(), 'oragent-rc-')) });
    const result = await runtime.execute('RunCode', { code: 'console.log(21 * 2)' });
    assert.equal(result.is_error, false);
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.exit_code, 0);
    assert.match(parsed.stdout, /42/);
});

test('RunCode reports nonzero exit codes', async () => {
    const runtime = createToolRuntime({ cwd: mkdtempSync(path.join(tmpdir(), 'oragent-rc-')) });
    const result = await runtime.execute('RunCode', {
        code: 'console.error("boom"); process.exit(3)',
    });
    const parsed = JSON.parse(result.content);
    assert.equal(parsed.exit_code, 3);
    assert.match(parsed.stderr, /boom/);
});

test('BrowserSnapshot fails with an install hint when no browser package exists', async (t) => {
    try {
        await import('playwright');
        t.skip('playwright installed — error path not testable');
        return;
    } catch {
        // expected: not installed
    }
    try {
        await import('puppeteer');
        t.skip('puppeteer installed — error path not testable');
        return;
    } catch {
        // expected: not installed
    }
    const runtime = createToolRuntime({ cwd: mkdtempSync(path.join(tmpdir(), 'oragent-bs-')) });
    const result = await runtime.execute('BrowserSnapshot', { url: 'http://localhost:1' });
    assert.equal(result.is_error, true);
    assert.match(result.content, /playwright|puppeteer/);
});
