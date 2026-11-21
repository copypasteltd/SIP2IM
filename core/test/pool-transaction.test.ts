import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { transaction, TransactionCommitUnknown, TransactionReleaseFailed, TransactionRolledBack } from '../src/db/pool.js';

function fake(failures: Record<string, unknown> = {}) {
  const events: string[] = [];
  const query = vi.fn(async (sql: string) => {
    events.push(sql);
    if (Object.hasOwn(failures, sql)) throw failures[sql];
    return { rows: [], command: sql === 'COMMIT' && Object.hasOwn(failures, 'command') ? failures.command : sql };
  });
  const release = vi.fn((destroy?: boolean) => {
    events.push(destroy ? 'discard' : 'release');
    if (Object.hasOwn(failures, 'release')) throw failures.release;
  });
  const client = { query, release };
  const connect = vi.fn(async () => {
    if (Object.hasOwn(failures, 'connect')) throw failures.connect;
    return client;
  });
  return { pool: { connect } as unknown as pg.Pool, client, events, connect, release };
}

describe('transaction', () => {
  it('returns the result and releases once after commit', async () => {
    const f = fake();
    const result = {};
    expect(await transaction(f.pool, async c => { expect(c).toBe(f.client); f.events.push('fn'); return result; })).toBe(result);
    expect(f.events).toEqual(['BEGIN', 'fn', 'COMMIT', 'release']);
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledWith();
  });
  it('checks the synchronous fence after work settles and rolls back without issuing COMMIT', async () => {
    const f = fake();
    const obsolete = new Error('authority changed');
    let current = true;
    const fence = vi.fn(() => { f.events.push('fence'); if (!current) throw obsolete; });
    const work = transaction(f.pool, async () => {
      f.events.push('fn');
      queueMicrotask(() => { current = false; f.events.push('lost'); });
      return 1;
    }, fence);
    await expect(work).rejects.toBe(obsolete);
    expect(f.events).toEqual(['BEGIN','fn','lost','fence','ROLLBACK','discard']);
    expect(fence).toHaveBeenCalledOnce();
  });
  it('does not release a client if acquisition fails', async () => {
    const error = new Error('connect'); const f = fake({ connect: error });
    await expect(transaction(f.pool, async () => 1)).rejects.toBe(error);
    expect(f.events).toEqual([]); expect(f.release).not.toHaveBeenCalled();
  });
  it.each(['BEGIN', 'fn', 'COMMIT'])('preserves %s error after rollback and discards the client', async stage => {
    const error = new Error(stage); const f = fake(stage === 'fn' ? {} : { [stage]: error });
    const fn = vi.fn(async () => { f.events.push('fn'); if (stage === 'fn') throw error; return 1; });
    const caught = await transaction(f.pool, fn).catch(e => e);
    if (stage === 'COMMIT') { expect(caught).toBeInstanceOf(TransactionCommitUnknown); expect(caught.cause).toBe(error); }
    else expect(caught).toBe(error);
    expect(f.events).toEqual(stage === 'BEGIN' ? ['BEGIN', 'ROLLBACK', 'discard'] : stage === 'fn' ? ['BEGIN', 'fn', 'ROLLBACK', 'discard'] : ['BEGIN', 'fn', 'COMMIT', 'ROLLBACK', 'discard']);
    expect(fn).toHaveBeenCalledTimes(stage === 'BEGIN' ? 0 : 1);
    expect(f.release).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledWith(true);
  });
  it.each(['BEGIN', 'fn', 'COMMIT'])('retains %s and rollback failures without exposing the original directly', async stage => {
    const original = new Error(stage); const rollback = new Error('rollback');
    const f = fake({ ...(stage === 'fn' ? {} : { [stage]: original }), ROLLBACK: rollback });
    const caught = await transaction(f.pool, async () => { if (stage === 'fn') throw original; return 1; }).catch(error => error);
    expect(caught).toBeInstanceOf(AggregateError);
    if (stage === 'COMMIT') { expect(caught.errors[0]).toBeInstanceOf(TransactionCommitUnknown); expect(caught.errors[0].cause).toBe(original); }
    else expect(caught.errors[0]).toBe(original);
    expect(caught.errors[1]).toBe(rollback);
    expect(f.release).toHaveBeenCalledOnce(); expect(f.release).toHaveBeenCalledWith(true);
  });
  it('rejects when COMMIT reports ROLLBACK', async () => {
    const f = fake({ command: 'ROLLBACK' });
    await expect(transaction(f.pool, async () => 1)).rejects.toBeInstanceOf(TransactionRolledBack);
    expect(f.events).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'discard']);
  });
  it.each([undefined, 'UPDATE'])('reports unknown outcome for COMMIT tag %s', async command => {
    const f = fake({ command });
    const caught = await transaction(f.pool, async () => 1).catch(e => e);
    expect(caught).toBeInstanceOf(TransactionCommitUnknown);
    expect(caught.cause.message).toContain('Unexpected COMMIT command tag');
    expect(f.events).toEqual(['BEGIN', 'COMMIT', 'ROLLBACK', 'discard']);
  });
  it('does not expose the original error when ROLLBACK has no confirmation tag', async () => {
    const original = new Error('work'); const f = fake();
    f.client.query.mockImplementation(async sql => { f.events.push(sql); return {rows: [], command: sql === 'ROLLBACK' ? undefined : sql}; });
    const caught = await transaction(f.pool, async () => { throw original; }).catch(e => e);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors[0]).toBe(original);
    expect(caught.errors[1].message).toContain('Unexpected ROLLBACK command tag');
    expect(f.release).toHaveBeenCalledWith(true);
  });
  it('retains transaction and release failures', async () => {
    const original = new Error('work'); const release = new Error('release'); const f = fake({ release });
    const caught = await transaction(f.pool, async () => { throw original; }).catch(error => error);
    expect(caught).toBeInstanceOf(AggregateError); expect(caught.errors).toEqual([original, release]);
    expect(f.events).toEqual(['BEGIN', 'ROLLBACK', 'discard']); expect(f.release).toHaveBeenCalledOnce();
  });
  it('propagates a release failure following a successful commit', async () => {
    const error = new Error('release'); const f = fake({ release: error });
    const caught = await transaction(f.pool, async () => 1).catch(e => e);
    expect(caught).toBeInstanceOf(TransactionReleaseFailed); expect(caught.cause).toBe(error);
    expect(f.events).toEqual(['BEGIN', 'COMMIT', 'release']); expect(f.release).toHaveBeenCalledOnce();
  });
});
