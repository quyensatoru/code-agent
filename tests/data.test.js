import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createToolRuntime } from '../src/tools/index.js';
import {
    assertReadOnlySql,
    assertReadOnlyRedis,
    assertReadOnlyPipeline,
} from '../src/tools/data.js';

const tmp = () => mkdtempSync(path.join(tmpdir(), 'oragent-data-'));

test('assertReadOnlySql accepts reads, rejects mutations and multi-statement', () => {
    assert.equal(assertReadOnlySql('SELECT * FROM users WHERE id = 1'), 'SELECT * FROM users WHERE id = 1');
    assert.ok(assertReadOnlySql('  with t as (select 1) select * from t -- note'));
    assert.ok(assertReadOnlySql('EXPLAIN SELECT 1'));
    assert.throws(() => assertReadOnlySql('UPDATE users SET x = 1'), /read-only/i);
    assert.throws(() => assertReadOnlySql('DELETE FROM users'), /read-only/i);
    assert.throws(() => assertReadOnlySql('SELECT * INTO copy FROM users'), /forbidden/i);
    assert.throws(() => assertReadOnlySql('SELECT 1; DROP TABLE users'), /single/i);
    assert.throws(() => assertReadOnlySql('DROP TABLE users'), /read-only/i);
});

test('assertReadOnlySql does not false-positive on column names', () => {
    // "created_at" / "deleted_at" contain create/delete but are not keywords.
    assert.ok(assertReadOnlySql('SELECT created_at, deleted_at FROM rows'));
});

test('assertReadOnlyRedis whitelists read commands', () => {
    assert.equal(assertReadOnlyRedis('get'), 'GET');
    assert.equal(assertReadOnlyRedis('HGETALL'), 'HGETALL');
    assert.throws(() => assertReadOnlyRedis('SET'), /read-only/i);
    assert.throws(() => assertReadOnlyRedis('FLUSHALL'), /read-only/i);
    assert.throws(() => assertReadOnlyRedis('DEL'), /read-only/i);
});

test('assertReadOnlyPipeline rejects $out/$merge', () => {
    assert.deepEqual(assertReadOnlyPipeline([{ $match: { a: 1 } }]), [{ $match: { a: 1 } }]);
    assert.throws(() => assertReadOnlyPipeline([{ $out: 'copy' }]), /\$out|\$merge/);
    assert.throws(() => assertReadOnlyPipeline([{ $match: {} }, { $merge: 'x' }]), /\$out|\$merge/);
});

test('SqlQuery errors clearly when no connection string is configured', async () => {
    const prev = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    try {
        const runtime = createToolRuntime({ cwd: tmp() });
        const result = await runtime.execute('SqlQuery', { query: 'SELECT 1' });
        assert.equal(result.is_error, true);
        assert.match(result.content, /No database URL/);
    } finally {
        if (prev !== undefined) process.env.DATABASE_URL = prev;
    }
});

test('SqlQuery rejects a mutating query before connecting', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('SqlQuery', {
        query: 'DELETE FROM users',
        url: 'postgres://localhost/db',
    });
    assert.equal(result.is_error, true);
    assert.match(result.content, /read-only/i);
});

test('RedisCommand rejects writes before connecting', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('RedisCommand', {
        command: 'SET',
        args: ['k', 'v'],
        url: 'redis://localhost:6379',
    });
    assert.equal(result.is_error, true);
    assert.match(result.content, /read-only/i);
});

test('MongoQuery validates operation enum', async () => {
    const runtime = createToolRuntime({ cwd: tmp() });
    const result = await runtime.execute('MongoQuery', {
        collection: 'users',
        operation: 'deleteMany',
        url: 'mongodb://localhost/db',
    });
    assert.equal(result.is_error, true);
    assert.match(result.content, /INVALID INPUT/);
});
