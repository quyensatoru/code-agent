import test from 'node:test';
import assert from 'node:assert/strict';
import { runHooks } from '../src/hooks/index.js';

test('PostToolUse hooks receive tool_response', async () => {
    let seen;
    const hooks = {
        PostToolUse: [
            {
                matcher: 'Bash',
                hooks: [
                    async (payload) => {
                        seen = payload;
                        return {};
                    },
                ],
            },
        ],
    };
    await runHooks('PostToolUse', hooks, {
        toolName: 'Bash',
        input: { command: 'ls' },
        toolResponse: { content: 'ok', is_error: false },
    });
    assert.equal(seen.hook_event_name, 'PostToolUse');
    assert.equal(seen.tool_name, 'Bash');
    assert.deepEqual(seen.tool_response, { content: 'ok', is_error: false });
});

test('PreToolUse hook can deny and rewrite input', async () => {
    const hooks = {
        PreToolUse: [
            {
                hooks: [
                    async () => ({
                        hookSpecificOutput: {
                            permissionDecision: 'allow',
                            updatedInput: { command: 'echo safe' },
                        },
                    }),
                ],
            },
        ],
    };
    const result = await runHooks('PreToolUse', hooks, {
        toolName: 'Bash',
        input: { command: 'rm -rf /' },
    });
    assert.equal(result.permissionDecision, 'allow');
    assert.deepEqual(result.updatedInput, { command: 'echo safe' });
});

test('Stop hooks run without a matcher and can block', async () => {
    const hooks = {
        Stop: [{ hooks: [async () => ({ decision: 'block', reason: 'tests not run yet' })] }],
    };
    const result = await runHooks('Stop', hooks, {});
    assert.equal(result.blocked, true);
    assert.equal(result.reason, 'tests not run yet');
});

test('matcher regex scopes tool hooks', async () => {
    let calls = 0;
    const hooks = {
        PreToolUse: [{ matcher: 'Write|Edit', hooks: [async () => (calls += 1, {})] }],
    };
    await runHooks('PreToolUse', hooks, { toolName: 'Edit', input: {} });
    await runHooks('PreToolUse', hooks, { toolName: 'Bash', input: {} });
    assert.equal(calls, 1);
});
