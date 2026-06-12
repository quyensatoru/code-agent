import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, classifyTool } from '../src/permissions/index.js';
import { parseRule, parseRules, ruleMatches, isReadOnlyBash } from '../src/permissions/rules.js';

test('parseRule handles bare names and Tool(spec)', () => {
    assert.deepEqual(parseRule('Bash'), { tool: 'Bash', pattern: null });
    assert.deepEqual(parseRule('Bash(npm *)'), { tool: 'Bash', pattern: 'npm *' });
    assert.deepEqual(parseRule('Edit(src/**)'), { tool: 'Edit', pattern: 'src/**' });
    assert.equal(parseRule(''), null);
});

test('ruleMatches matches Bash commands by glob', () => {
    const rule = parseRule('Bash(npm *)');
    assert.ok(ruleMatches(rule, 'Bash', { command: 'npm install express' }));
    assert.ok(!ruleMatches(rule, 'Bash', { command: 'rm -rf /' }));
    assert.ok(!ruleMatches(rule, 'Bash', { command: 'npm' })); // needs the space
});

test('ruleMatches matches file tools by path', () => {
    const rule = parseRule('Edit(src/*)');
    assert.ok(ruleMatches(rule, 'Edit', { path: 'src/app.js' }));
    assert.ok(!ruleMatches(rule, 'Write', { path: 'src/app.js' }));
});

test('isReadOnlyBash accepts safe prefixes, rejects metacharacters', () => {
    assert.ok(isReadOnlyBash('git status'));
    assert.ok(isReadOnlyBash('git log --oneline -5'));
    assert.ok(isReadOnlyBash('ls -la'));
    assert.ok(!isReadOnlyBash('git status; rm -rf /'));
    assert.ok(!isReadOnlyBash('cat foo > bar'));
    assert.ok(!isReadOnlyBash('npm install'));
    assert.ok(!isReadOnlyBash(''));
});

test('classifyTool buckets', () => {
    assert.equal(classifyTool('Read'), 'read');
    assert.equal(classifyTool('Agent'), 'read');
    assert.equal(classifyTool('Write'), 'edit');
    assert.equal(classifyTool('Bash'), 'bash');
    assert.equal(classifyTool('mcp__x__y'), 'other');
});

test('evaluate: deny rules win over everything', async () => {
    const result = await evaluate({
        mode: 'bypassPermissions',
        allowDangerouslySkip: true,
        name: 'Bash',
        input: { command: 'rm -rf node_modules' },
        denyRules: parseRules(['Bash(rm *)']),
    });
    assert.equal(result.behavior, 'deny');
});

test('evaluate: plan mode allows reads and safe bash, denies edits', async () => {
    assert.equal((await evaluate({ mode: 'plan', name: 'Read', input: {} })).behavior, 'allow');
    assert.equal(
        (await evaluate({ mode: 'plan', name: 'Bash', input: { command: 'git status' } })).behavior,
        'allow'
    );
    assert.equal((await evaluate({ mode: 'plan', name: 'Write', input: {} })).behavior, 'deny');
});

test('evaluate: allow rules auto-approve without canUseTool', async () => {
    const result = await evaluate({
        mode: 'default',
        name: 'Bash',
        input: { command: 'npm test' },
        allowRules: parseRules(['Bash(npm *)']),
    });
    assert.equal(result.behavior, 'allow');
});

test('evaluate: acceptEdits allows edits, still gates bash via canUseTool', async () => {
    assert.equal(
        (await evaluate({ mode: 'acceptEdits', name: 'Edit', input: {} })).behavior,
        'allow'
    );
    const denied = await evaluate({
        mode: 'acceptEdits',
        name: 'Bash',
        input: { command: 'npm install' },
    });
    assert.equal(denied.behavior, 'deny');
    const asked = await evaluate({
        mode: 'acceptEdits',
        name: 'Bash',
        input: { command: 'npm install' },
        canUseTool: async () => ({ behavior: 'allow' }),
    });
    assert.equal(asked.behavior, 'allow');
});

test('evaluate: safe read-only bash never prompts in default mode', async () => {
    const result = await evaluate({ mode: 'default', name: 'Bash', input: { command: 'git diff' } });
    assert.equal(result.behavior, 'allow');
});
