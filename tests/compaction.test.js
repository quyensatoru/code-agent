import test from 'node:test';
import assert from 'node:assert/strict';
import {
    compact,
    estimateTokens,
    findCompactBoundary,
    trimOldToolResults,
} from '../src/context/compaction.js';

function makeHistory(turns) {
    const messages = [{ role: 'system', content: 'system prompt' }];
    for (let i = 0; i < turns; i += 1) {
        messages.push({ role: 'user', content: `user turn ${i} ${'x'.repeat(500)}` });
        messages.push({
            role: 'assistant',
            content: '',
            tool_calls: [{ id: `t${i}`, function: { name: 'Read', arguments: '{"path":"a"}' } }],
        });
        messages.push({ role: 'tool', tool_call_id: `t${i}`, content: 'y'.repeat(5000) });
        messages.push({ role: 'assistant', content: `answer ${i}` });
    }
    return messages;
}

test('estimateTokens counts content and tool calls', () => {
    const tokens = estimateTokens(makeHistory(2));
    assert.ok(tokens > 2000, `expected > 2000, got ${tokens}`);
});

test('trimOldToolResults truncates only old large tool outputs', () => {
    const messages = makeHistory(4);
    const trimmed = trimOldToolResults(messages, { keepTail: 4, maxChars: 1000 });
    const oldTool = trimmed.find((m) => m.role === 'tool');
    assert.match(oldTool.content, /older tool output trimmed/);
    // tail untouched
    const lastTool = trimmed.filter((m) => m.role === 'tool').at(-1);
    assert.doesNotMatch(lastTool.content, /trimmed/);
    // original array untouched
    assert.doesNotMatch(messages.find((m) => m.role === 'tool').content, /trimmed/);
});

test('findCompactBoundary never splits a tool result from its assistant call', () => {
    const messages = makeHistory(5);
    for (let keep = 2; keep < 10; keep += 1) {
        const start = findCompactBoundary(messages, keep);
        assert.notEqual(messages[start]?.role, 'tool');
        assert.ok(start >= 1);
    }
});

test('compact replaces old history with a summary message', async () => {
    const messages = makeHistory(6);
    const fakeClient = {
        chat: async () => ({ choices: [{ message: { content: 'SUMMARY OF WORK' } }] }),
    };
    const result = await compact({ client: fakeClient, model: 'm', messages, keepRecent: 6 });
    assert.ok(result);
    assert.equal(result.messages[0].role, 'system');
    assert.match(result.messages[1].content, /SUMMARY OF WORK/);
    assert.ok(result.messages.length < messages.length);
    assert.notEqual(result.messages[2]?.role, 'tool');
});

test('compact returns null when history is too short', async () => {
    const messages = makeHistory(1);
    const result = await compact({ client: { chat: async () => ({}) }, model: 'm', messages });
    assert.equal(result, null);
});
