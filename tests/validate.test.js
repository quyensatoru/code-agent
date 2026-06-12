import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInput } from '../src/tools/validate.js';

const schema = {
    type: 'object',
    required: ['path'],
    properties: {
        path: { type: 'string' },
        max_results: { type: 'integer', minimum: 1, maximum: 100 },
        overwrite: { type: 'boolean' },
        mode: { type: 'string', enum: ['a', 'b'] },
        todos: {
            type: 'array',
            items: {
                type: 'object',
                required: ['content'],
                properties: { content: { type: 'string' } },
            },
        },
    },
};

test('coerces numeric strings and booleans', () => {
    const { value, errors } = validateInput(schema, {
        path: 'src',
        max_results: '25',
        overwrite: 'true',
    });
    assert.deepEqual(errors, []);
    assert.equal(value.max_results, 25);
    assert.equal(value.overwrite, true);
});

test('reports missing required and range violations', () => {
    const { errors } = validateInput(schema, { max_results: 1000 });
    assert.ok(errors.some((e) => e.includes('required parameter "path"')));
    assert.ok(errors.some((e) => e.includes('<= 100')));
});

test('enum violations are reported', () => {
    const { errors } = validateInput(schema, { path: 'x', mode: 'c' });
    assert.ok(errors.some((e) => e.includes('one of: a, b')));
});

test('validates nested array items', () => {
    const { errors } = validateInput(schema, { path: 'x', todos: [{}] });
    assert.ok(errors.some((e) => e.includes('todos[0].content')));
});

test('non-array where array expected', () => {
    const { errors } = validateInput(schema, { path: 'x', todos: 'nope' });
    assert.ok(errors.some((e) => e.includes('must be an array')));
});
