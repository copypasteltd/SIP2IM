import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { PairingRepository } from '../src/channels/pairing-repo.js';
import { ChannelRepository } from '../src/channels/repo.js';
import { TransactionCommitUnknown } from '../src/db/pool.js';

const operations = [
  ['issue', (pool: pg.Pool) => new PairingRepository(pool).issue('qq', Buffer.alloc(32))],
  ['revoke', (pool: pg.Pool) => new ChannelRepository(pool).revokePairedUser('qq')],
] as const;

describe.each(operations)('%s transaction failures', (_name, run) => {
  it('preserves work and rollback failures and discards the client', async () => {
    const workError = new Error('update failed');
    const rollbackError = new Error('rollback failed');
    const events: string[] = [];
    const query = vi.fn(async (sql: string) => {
      events.push(sql);
      if (sql.startsWith('SELECT platform')) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith('UPDATE pairing_code')) throw workError;
      if (sql === 'ROLLBACK') throw rollbackError;
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    const error = await run(pool).catch(e => e);
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toEqual([workError, rollbackError]);
    expect(events[0]).toBe('BEGIN');
    expect(events[1]).toContain('FOR UPDATE');
    expect(events[2]).toContain('UPDATE pairing_code');
    expect(events.at(-1)).toBe('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });

  it('reports an uncertain commit and discards the client', async () => {
    const commitError = new Error('connection lost');
    const events: string[] = [];
    const query = vi.fn(async (sql: string) => {
      events.push(sql);
      if (sql.startsWith('SELECT platform')) return { rowCount: 1, rows: [{}] };
      if (sql.startsWith('INSERT INTO pairing_code')) return { rows: [{ expiresAt: '123' }] };
      if (sql === 'COMMIT') throw commitError;
      return { rows: [], command: sql };
    });
    const release = vi.fn();
    const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
    const error = await run(pool).catch(e => e);
    expect(error).toBeInstanceOf(TransactionCommitUnknown);
    expect(error.cause).toBe(commitError);
    expect(events.slice(-2)).toEqual(['COMMIT', 'ROLLBACK']);
    expect(release).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledWith(true);
  });
});
