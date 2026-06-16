import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseSelection, isProvisioned, readWorkspace, provisionWorkspace } from '../src/workspace/index.js';
import { tokenizeCloneUrl, gitlabApiBase, parseSkippedFiles } from '../src/workspace/gitlab.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'oragent-ws-'));

test('parseSelection parses all, ranges, and lists; clamps out-of-range', () => {
    assert.deepEqual(parseSelection('all', 4), [1, 2, 3, 4]);
    assert.deepEqual(parseSelection('*', 2), [1, 2]);
    assert.deepEqual(parseSelection('1,3-5', 6), [1, 3, 4, 5]);
    assert.deepEqual(parseSelection('2, 2, 9', 3), [2]); // dedupe + drop out-of-range
    assert.deepEqual(parseSelection('', 3), []);
});

test('tokenizeCloneUrl injects oauth2 token, leaves path intact', () => {
    assert.equal(
        tokenizeCloneUrl('https://gitlab.com/acme/app.git', 'glpat-xyz'),
        'https://oauth2:glpat-xyz@gitlab.com/acme/app.git'
    );
});

test('gitlabApiBase normalizes host and defaults to gitlab.com', () => {
    assert.equal(gitlabApiBase(), 'https://gitlab.com/api/v4');
    assert.equal(gitlabApiBase('https://git.acme.io/'), 'https://git.acme.io/api/v4');
});

test('isProvisioned / readWorkspace reflect the marker file', async () => {
    const dir = tmp();
    assert.equal(await isProvisioned(dir), false);
    mkdirSync(path.join(dir, '.oragent'), { recursive: true });
    writeFileSync(
        path.join(dir, '.oragent', 'workspace.json'),
        JSON.stringify({ group: 'acme', repos: [{ path: 'app' }] })
    );
    assert.equal(await isProvisioned(dir), true);
    assert.equal((await readWorkspace(dir)).group, 'acme');
});

test('parseSkippedFiles extracts OS-illegal paths from checkout errors', () => {
    const stderr = [
        "Cloning into 'C:\\ws\\SAMA\\sama-extensions'...",
        'error: unable to create file extensions/web-pixel/src/events /cart_viewed.js: No such file or directory',
        'error: unable to create file extensions/web-pixel/src/events /index.js: No such file or directory',
        'fatal: unable to checkout working tree',
        'warning: Clone succeeded, but checkout failed.',
    ].join('\n');
    const skipped = parseSkippedFiles(stderr);
    assert.deepEqual(skipped, [
        'extensions/web-pixel/src/events /cart_viewed.js',
        'extensions/web-pixel/src/events /index.js',
    ]);
    assert.deepEqual(parseSkippedFiles(''), []);
});

test('provisionWorkspace requires a token', async () => {
    const prev = process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_TOKEN;
    try {
        await assert.rejects(
            () => provisionWorkspace({ workspace: tmp(), group: 'acme', selectProjects: async () => [] }),
            /GITLAB_TOKEN/
        );
    } finally {
        if (prev !== undefined) process.env.GITLAB_TOKEN = prev;
    }
});
