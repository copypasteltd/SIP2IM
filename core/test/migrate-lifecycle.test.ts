import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { TransactionCommitUnknown, TransactionRolledBack } from '../src/db/pool.js';

let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(resolve('migration-test-'));
  await writeFile(join(directory, '0001_test.sql'), 'SELECT migration_sql');
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

type Reply = { command?: string; rows: Record<string, unknown>[]; rowCount?: number };
function fake(overrides: Record<string, Error | Reply> = {}) {
  const calls: string[] = [];
  const release = vi.fn();
  const client = {
    release,
    query: vi.fn(async (sql: string): Promise<Reply> => {
      const key = sql.startsWith('SELECT pg_advisory_lock(') ? 'lock'
        : sql.startsWith('SELECT pg_advisory_unlock(') ? 'unlock'
        : sql.startsWith('CREATE TABLE') ? 'create'
        : sql.startsWith('SELECT 1 FROM') ? 'exists'
        : sql.startsWith('INSERT INTO') ? 'insert'
        : sql === 'SELECT migration_sql' ? 'sql' : sql;
      calls.push(key);
      const override = overrides[key];
      if (override instanceof Error) throw override;
      if (override) return override;
      if (key === 'unlock') return { rows: [{ unlocked: true }] };
      if (key === 'exists') return { rows: [], rowCount: 0 };
      return { rows: [], command: key };
    }),
  };
  const pool = { connect: vi.fn(async () => client), query: vi.fn(() => { throw new Error('pool query used'); }) };
  return { pool: pool as unknown as pg.Pool, client, calls, release };
}

describe('migration session lock lifecycle', () => {
  it('uses one client for lock, transaction and verified unlock', async () => {
    const f = fake();
    await migrate(f.pool, directory);
    expect(f.calls).toEqual(['lock', 'create', 'exists', 'BEGIN', 'sql', 'insert', 'COMMIT', 'unlock']);
    expect(f.release).toHaveBeenCalledWith(false);
    expect(f.pool.query).not.toHaveBeenCalled();
  });

  it.each(['lock', 'BEGIN', 'sql', 'insert', 'COMMIT'])('cleans up and discards on %s failure', async stage => {
    const primary = new Error(stage + ' failed');
    const f = fake({ [stage]: primary });
    let caught: unknown;
    try { await migrate(f.pool, directory); } catch (error) { caught = error; }
    if (stage === 'COMMIT') {
      expect(caught).toBeInstanceOf(TransactionCommitUnknown);
      expect((caught as Error).cause).toBe(primary);
    } else expect(caught).toBe(primary);
    expect(f.calls.at(-1)).toBe('unlock');
    expect(f.calls.includes('ROLLBACK')).toBe(stage !== 'lock');
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it('preserves primary, rollback, unlock and release errors in order', async () => {
    const primary = new Error('sql');
    const rollback = new Error('rollback');
    const unlock = new Error('unlock');
    const release = new Error('release');
    const f = fake({ sql: primary, ROLLBACK: rollback, unlock });
    f.release.mockImplementation(() => { throw release; });
    let caught: unknown;
    try { await migrate(f.pool, directory); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    expect((caught as AggregateError).errors).toEqual([primary, rollback, unlock, release]);
    expect(f.calls.slice(-2)).toEqual(['ROLLBACK', 'unlock']);
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it.each([{ rows: [] }, { rows: [], command: 'COMMIT' }])('preserves an unconfirmed rollback with the primary error %#', async result => {
    const primary = new Error('migration failed');
    const f = fake({ sql: primary, ROLLBACK: result });
    let caught: unknown;
    try { await migrate(f.pool, directory); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(AggregateError);
    const errors = (caught as AggregateError).errors;
    expect(errors[0]).toBe(primary);
    expect(errors[1]).toBeInstanceOf(Error);
    expect(errors[1].message).toContain('ROLLBACK was not confirmed');
    expect(f.calls.slice(-2)).toEqual(['ROLLBACK', 'unlock']);
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it.each([{ rows: [{ unlocked: false }] }, { rows: [] }, { rows: [{ unlocked: 't' }] }])('rejects an unconfirmed unlock %#', async result => {
    const f = fake({ unlock: result });
    await expect(migrate(f.pool, directory)).rejects.toThrow('not confirmed unlocked');
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it('reports a missing COMMIT tag as an unknown outcome', async () => {
    const f = fake({ COMMIT: { rows: [] } });
    await expect(migrate(f.pool, directory)).rejects.toBeInstanceOf(TransactionCommitUnknown);
    expect(f.calls.slice(-2)).toEqual(['ROLLBACK', 'unlock']);
    expect(f.release).toHaveBeenCalledWith(true);
  });

  it('treats a COMMIT reported as ROLLBACK as failure', async () => {
    const f = fake({ COMMIT: { rows: [], command: 'ROLLBACK' } });
    await expect(migrate(f.pool, directory)).rejects.toBeInstanceOf(TransactionRolledBack);
    expect(f.calls.slice(-2)).toEqual(['ROLLBACK', 'unlock']);
    expect(f.release).toHaveBeenCalledWith(true);
  });
});
