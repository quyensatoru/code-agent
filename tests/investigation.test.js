import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';
import { EXPLORATION_TOOLS } from '../src/tools/meta.js';
import { searchBudgetNudge } from '../src/core/search-budget.js';
import { normalizeOptions } from '../src/core/options.js';

function makeCallGraph() {
    const dir = mkdtempSync(path.join(tmpdir(), 'oragent-tc-'));
    mkdirSync(path.join(dir, 'src'));
    // main -> handle -> compute (the buggy leaf)
    writeFileSync(
        path.join(dir, 'src', 'app.js'),
        [
            'function compute(x) { return x * 2; }',
            'function handle(req) { return compute(req.value); }',
            'function main() { handle({ value: 21 }); }',
            'main();',
        ].join('\n')
    );
    return dir;
}

test('TraceCalls (callers) traces the execution path up to the entry point', async () => {
    const runtime = createToolRuntime({ cwd: makeCallGraph() });
    const result = await runtime.execute('TraceCalls', { symbol: 'compute' });
    assert.equal(result.is_error, false);
    const trace = JSON.parse(result.content);
    assert.ok(trace.definitions.some((d) => d.includes('src/app.js:1')));
    // compute is called inside handle…
    const handle = trace.callers.find((c) => c.caller === 'handle');
    assert.ok(handle, 'expected handle to be a caller of compute');
    // …and handle is called inside main (one level up).
    assert.ok(handle.callers?.some((c) => c.caller === 'main'));
});

test('TraceCalls (callees) lists what a function calls', async () => {
    const runtime = createToolRuntime({ cwd: makeCallGraph() });
    const result = await runtime.execute('TraceCalls', { symbol: 'handle', direction: 'callees' });
    const trace = JSON.parse(result.content);
    assert.ok(trace.callees.includes('compute'));
});

test('Hypothesize records structured predictions and a stop directive', async () => {
    const runtime = createToolRuntime({ cwd: mkdtempSync(path.join(tmpdir(), 'oragent-h-')) });
    const result = await runtime.execute('Hypothesize', {
        hypotheses: [
            { cause: 'off-by-one in pagination', predicts: 'last page empty', check: 'Grep "offset"' },
            { cause: 'wrong env default', check: 'Read config.js' },
        ],
    });
    assert.equal(result.is_error, false);
    const out = JSON.parse(result.content);
    assert.equal(out.recorded, 2);
    assert.equal(out.hypotheses[0].status, 'open');
    assert.match(out.directive, /stop|confirmed/i);
});

test('Hypothesize requires cause and check per item', async () => {
    const runtime = createToolRuntime({ cwd: mkdtempSync(path.join(tmpdir(), 'oragent-h-')) });
    const result = await runtime.execute('Hypothesize', { hypotheses: [{ predicts: 'x' }] });
    assert.equal(result.is_error, true);
    assert.match(result.content, /INVALID INPUT/);
});

test('exploration tools are tracked for convergence pressure', () => {
    for (const name of ['Grep', 'Read', 'TraceCalls', 'CodebaseMap']) {
        assert.ok(EXPLORATION_TOOLS.has(name), `${name} should count as exploration`);
    }
    for (const name of ['Edit', 'Bash', 'Hypothesize', 'RunCode']) {
        assert.ok(!EXPLORATION_TOOLS.has(name), `${name} should reset the streak`);
    }
});

test('searchBudgetNudge fires at the limit and re-fires every limit, off when disabled', () => {
    assert.equal(searchBudgetNudge(15, 0, 16), null);
    const first = searchBudgetNudge(16, 0, 16);
    assert.ok(first && first.warnAt === 16);
    assert.match(first.message, /Hypothesize/);
    assert.equal(searchBudgetNudge(20, 16, 16), null); // not yet another full window
    assert.ok(searchBudgetNudge(32, 16, 16)); // next window
    assert.equal(searchBudgetNudge(50, 0, 0), null); // disabled
});

test('normalizeOptions: maxSearchSteps default and disable', () => {
    assert.equal(normalizeOptions({}).maxSearchSteps, 16);
    assert.equal(normalizeOptions({ maxSearchSteps: 0 }).maxSearchSteps, 0);
    assert.equal(normalizeOptions({ maxSearchSteps: false }).maxSearchSteps, 0);
    assert.equal(normalizeOptions({ maxSearchSteps: 30 }).maxSearchSteps, 30);
});
