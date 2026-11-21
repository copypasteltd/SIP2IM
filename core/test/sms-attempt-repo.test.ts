import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { readFile } from 'node:fs/promises';
import { TransactionCommitUnknown, TransactionReleaseFailed, TransactionRolledBack } from '../src/db/pool.js';
import { SmsAttemptRepository, type SmsAttemptClaim } from '../src/sms/attempt-repo.js';

it('keeps the migration additive and fences task and command reuse', async () => {
  const sql = await readFile('migrations/0019_sms_dispatch_attempt.sql', 'utf8');
  expect(sql).toContain('task_id text PRIMARY KEY REFERENCES sms_task(id)');
  expect(sql).toContain('command_id text NOT NULL UNIQUE');
  expect(sql).toContain('CREATE UNIQUE INDEX sms_dispatch_ack_observation');
  expect(sql).not.toMatch(/INSERT\s+INTO|UPDATE\s+sms_task/i);
});

const input: SmsAttemptClaim = { taskId: 'task', deviceId: 'device', simId: 'sim', slot: 0, subId: 1, commandId: 'cmd_7ZZZZZZZZZ0000000000000001' };
const otherId = 'cmd_7ZZZZZZZZZ0000000000000002';
const accepted = { ok: true, error: null };
const negative = { ok: false, error: 'CONFLICT' };

type Observation = { ok: boolean; error_code: string | null };
type State = {
  task: string;
  code: string | null;
  negative: boolean;
  command?: string;
  reservation?: string;
  observations: Observation[];
  invalidations: number;
};
type Fault = 'lost-before' | 'lost-after' | 'release' | 'rollback-tag';

// Offline scripted transaction fixture. PostgreSQL concurrency and command tags need separate coverage.
function fixture(options: { owner?: boolean; legacy?: boolean; reservationConflict?: boolean; insertConflict?: boolean; expired?: boolean } = {}) {
  let state: State = { task: 'queued', code: null, negative: false, observations: [], invalidations: 0 };
  let draft: State | undefined;
  let fault: Fault | undefined;
  let failProjection = false;
  let outcome: string | null = null;
  let ownerMatches = true;
  const results: { payload: {state: string; errorCode: string | null} }[] = [];
  const row = (value: object = {}) => ({ rows: [value], rowCount: 1 });
  const none = () => ({ rows: [], rowCount: 0 });
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === 'BEGIN') {
      draft = structuredClone(state);
      return { ...none(), command: sql };
    }
    if (sql === 'ROLLBACK') {
      draft = undefined;
      return { ...none(), command: sql };
    }
    const transaction = draft!;
    if (sql === 'COMMIT') {
      const failure = fault;
      if (failure !== 'release') fault = undefined;
      if (transaction.reservation && state.task === 'queued') outcome = failure === 'lost-before' || failure === 'rollback-tag' ? 'aborted' : 'committed';
      if (failure === 'rollback-tag') return { ...none(), command: 'ROLLBACK' };
      if (failure !== 'lost-before') state = transaction;
      if (failure === 'lost-before' || failure === 'lost-after') throw new Error('lost commit reply');
      return { ...none(), command: sql };
    }
    if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED' || sql === 'SET LOCAL synchronous_commit = on') return none();
    if (sql.startsWith('SELECT id FROM device') || sql.startsWith('SELECT id FROM sim')) return row();
    if (sql.startsWith('SELECT t.id')) return options.owner === false || (sql.includes("t.state='queued'") && transaction.task !== 'queued') ? none() : row();
    if (sql.startsWith('SELECT 1 FROM call_outbound_attempt')) return options.legacy || transaction.command ? row() : none();
    if (sql.startsWith('INSERT INTO command_namespace_reservation')) {
      if (options.reservationConflict) return none();
      transaction.reservation = String(args[0]);
      return row();
    }
    if (sql.startsWith('INSERT INTO sms_dispatch_attempt')) {
      if (options.insertConflict) return none();
      transaction.command = String(args[2]);
      return row();
    }
    if (sql.startsWith("UPDATE sms_task SET state='dispatched'")) {
      if (options.expired) return none();
      transaction.task = 'dispatched';
      return row();
    }
    if (sql.startsWith('INSERT INTO sms_maintenance_admin_invalidation')) {
      transaction.invalidations++;
      return row();
    }
    if (sql === 'SELECT pg_current_xact_id()::text AS xid') return row({ xid: '42' });
    if (sql.startsWith('SELECT pg_xact_status')) return row({ status: outcome });
    if (sql.startsWith('SELECT a.command_id')) {
      return ownerMatches && transaction.command && transaction.command === transaction.reservation ? row({ commandId: transaction.command }) : none();
    }
    if (sql.startsWith('INSERT INTO sms_dispatch_ack_evidence')) {
      const observation = { ok: Boolean(args[1]), error_code: args[2] as string | null };
      if (!transaction.observations.some(r => r.ok === observation.ok && r.error_code === observation.error_code)) transaction.observations.push(observation);
      return row();
    }
    if (sql.startsWith('SELECT ok,error_code')) {
      if (failProjection) throw new Error('projection unavailable');
      return { rows: transaction.observations.slice(0, 2) };
    }
    if (sql.startsWith("UPDATE sms_task SET state='accepted'")) {
      if (transaction.task !== 'dispatched') return none();
      transaction.task = 'accepted';
      return row();
    }
    if (sql.startsWith('UPDATE sms_task SET state=CASE')) {
      if (transaction.negative) return none();
      if (transaction.task === 'dispatched') { transaction.task = 'failed'; transaction.code = String(args[1]); }
      transaction.negative = true;
      return row();
    }
    if (sql.includes("SET state='unknown',error_code='SMS_RESULT_CONFLICT'")) {
      if (sql.includes('negative_ack OR local_failure') && !transaction.negative) return none();
      if (transaction.code === 'SMS_RESULT_CONFLICT') return none();
      transaction.task = 'unknown';
      transaction.code = 'SMS_RESULT_CONFLICT';
      return row();
    }
    if (sql.startsWith("UPDATE sms_task SET state='unknown'")) {
      if (transaction.task !== 'dispatched') return none();
      transaction.task = 'unknown';
      return row();
    }
    if (sql.startsWith('UPDATE sms_task SET state=$2')) {
      if (transaction.code !== 'SMS_RESULT_CONFLICT' && (transaction.task === 'accepted' || transaction.task === 'unknown')) transaction.task = String(args[1]);
      return row();
    }
    if (sql.startsWith('SELECT id FROM sms_task WHERE state=')) return transaction.task === 'dispatched' ? row({ id: input.taskId }) : none();
    if (sql.startsWith('SELECT e.payload')) return { rows: results };
    throw new Error('Unexpected SQL: ' + sql);
  });
  const release = vi.fn(() => {
    if (fault === 'release') { fault = undefined; throw new Error('release failure'); }
  });
  const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
  return {
    pool, repo: new SmsAttemptRepository(pool), query, release, results,
    current: () => state,
    fault(value: Fault) { fault = value; },
    projectionFailure(value: boolean) { failProjection = value; },
    txOutcome(value: string | null) { outcome = value; },
    ownerMatches(value: boolean) { ownerMatches = value; },
  };
}

const statements = (f: ReturnType<typeof fixture>) => f.query.mock.calls.map(([sql]) => sql);

describe('durable outbound SMS attempts', () => {
  it('locks owner and eligibility, reserves the exact tuple and enqueues invalidation before committing', async () => {
    const f = fixture();
    expect(await f.repo.prepare(input).claim()).toBe(true);
    expect(f.current()).toMatchObject({ task: 'dispatched', command: input.commandId, reservation: input.commandId, invalidations: 1 });
    const sql = statements(f);
    expect(sql[1]).toBe('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    expect(sql[2]).toBe('SET LOCAL synchronous_commit = on');
    expect(sql[3]).toContain('FROM device');
    expect(sql[4]).toContain('slot=$3 AND sub_id IS NOT DISTINCT FROM $4 FOR UPDATE');
    expect(sql[5]).toContain("m.device_id=$2 AND m.sim_id=$3 AND m.direction='out'");
    expect(sql[5]).toContain('FOR UPDATE OF t');
    expect(sql[6]).toContain('call_outbound_attempt');
    expect(f.query.mock.calls[7]?.[1]).toEqual([input.commandId, 'sms.send', 'sms_task', input.taskId, input.deviceId]);
    expect(sql[9]).toContain("created_at>clock_timestamp()-interval '24 hours'");
    expect(sql[10]).toContain('ON CONFLICT (task_id) DO UPDATE');
    expect(sql.at(-1)).toBe('COMMIT');
  });

  it.each([{ owner: false }, { legacy: true }, { reservationConflict: true }, { insertConflict: true }, { expired: true }])('cannot leave a partial reservation or claim for %j', async options => {
    const f = fixture(options);
    const attempt = f.repo.prepare(input);
    expect(await attempt.claim()).toBe(false);
    await attempt.markUnknown();
    expect(f.current()).toEqual({ task: 'queued', code: null, negative: false, observations: [], invalidations: 0 });
    expect(statements(f)).not.toContain('SELECT pg_current_xact_id()::text AS xid');
  });

  it.each([['lost-after', TransactionCommitUnknown], ['release', TransactionReleaseFailed]] as const)('recovers confirmed durable work after %s without permitting ACK attribution', async (fault, error) => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    f.fault(fault);
    await expect(attempt.claim()).rejects.toBeInstanceOf(error);
    await expect(attempt.acknowledge(accepted)).rejects.toThrow('no confirmed local claim');
    expect(f.current().task).toBe('dispatched');
    await attempt.markUnknown();
    expect(f.current()).toMatchObject({ task: 'unknown', command: input.commandId, observations: [], invalidations: 2 });
    const sql = statements(f);
    const check = sql.findIndex(s => s.startsWith('SELECT pg_xact_status'));
    expect(sql[check - 1]).toContain('FOR UPDATE OF t');
    expect(f.query.mock.calls[check]?.[1]).toEqual(['42']);
  });

  it('does not mutate another claim after the original transaction aborted, even with the same IDs', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    f.fault('lost-before');
    await expect(attempt.claim()).rejects.toBeInstanceOf(TransactionCommitUnknown);
    expect(await f.repo.prepare(input).claim()).toBe(true);
    f.txOutcome('aborted'); // The original XID is separate from the later claim.
    await attempt.markUnknown();
    expect(f.current().task).toBe('dispatched');
    expect(statements(f).some(s => s.startsWith("UPDATE sms_task SET state='unknown'"))).toBe(false);
  });

  it('keeps an unresolved claim pending even when a task lookup sees no attempt', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    f.fault('lost-before');
    await expect(attempt.claim()).rejects.toBeInstanceOf(TransactionCommitUnknown);
    f.txOutcome(null);
    await expect(attempt.markUnknown()).rejects.toThrow('transaction outcome is unresolved');
    expect(f.current().task).toBe('queued');
  });

  it('distinguishes the explicit ROLLBACK command tag', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    f.fault('rollback-tag');
    await expect(attempt.claim()).rejects.toBeInstanceOf(TransactionRolledBack);
    await attempt.markUnknown();
    expect(f.current().task).toBe('queued');
    expect(statements(f).some(s => s.startsWith('SELECT pg_xact_status'))).toBe(false);
  });

  it('replays the committed negative ACK after restart when projection failed and the result was already recorded', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    await attempt.claim();
    f.results.push({ payload: { state: 'sent', errorCode: null } });
    f.projectionFailure(true);
    await expect(attempt.acknowledge(negative)).rejects.toThrow('projection unavailable');
    expect(f.current()).toMatchObject({ task: 'dispatched', negative: false, observations: [{ ok: false, error_code: 'CONFLICT' }] });
    f.projectionFailure(false);
    expect(await new SmsAttemptRepository(f.pool).reconcile()).toBe(1);
    expect(f.current()).toMatchObject({ task: 'unknown', code: 'SMS_RESULT_CONFLICT', negative: true, invalidations: 2 });
    const sql = statements(f);
    const evidence = sql.findIndex(s => s.startsWith('INSERT INTO sms_dispatch_ack_evidence'));
    expect(sql[evidence - 1]).toContain("r.owner_type='sms_task'");
    expect(sql[evidence + 1]).toBe('COMMIT');
    expect(sql[evidence + 2]).toBe('BEGIN');
    const replay = sql.findIndex(s => s.startsWith('SELECT e.payload'));
    expect(sql[replay - 1]).toContain('negative_ack=true');
    expect(sql[replay - 2]).toContain('sms_dispatch_ack_evidence');
    expect(sql[replay - 4]).toContain('FOR UPDATE');
  });

  it('retries a lost ACK commit idempotently and never falls back to unknown', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    await attempt.claim();
    f.fault('lost-after');
    await expect(attempt.acknowledge(negative)).rejects.toBeInstanceOf(TransactionCommitUnknown);
    expect(f.current().task).toBe('dispatched');
    await attempt.acknowledge(negative);
    expect(f.current()).toMatchObject({ task: 'failed', code: 'CONFLICT', negative: true, observations: [{ ok: false, error_code: 'CONFLICT' }] });
    await attempt.acknowledge(negative);
    expect(f.current().observations).toHaveLength(1);
  });

  it('reconciles an attempt without an ACK and never attributes unverified legacy ACKs', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    await attempt.claim();
    f.current().observations.push({ ok: true, error_code: null });
    f.ownerMatches(false);
    await expect(attempt.acknowledge(accepted)).rejects.toThrow('attempt is unverified');
    await expect(attempt.markUnknown()).rejects.toThrow('attempt is unverified');
    await expect(new SmsAttemptRepository(f.pool).reconcile()).resolves.toBe(1);
    expect(f.current()).toMatchObject({ task: 'unknown', command: input.commandId, observations: [{ ok: true, error_code: null }] });
    expect(statements(f).some(s => s.startsWith('SELECT ok,error_code'))).toBe(false);
  });

  it('rolls back startup recovery when ownership is lost while taking task locks', async () => {
    const f = fixture();
    await f.repo.prepare(input).claim();
    const guard = vi.fn().mockImplementationOnce(() => {}).mockImplementation(() => { throw new Error('ownership lost'); });
    await expect(f.repo.reconcile(guard)).rejects.toThrow('ownership lost');
    expect(f.current()).toMatchObject({ task: 'dispatched', invalidations: 1 });
    const sql = statements(f);
    expect(sql.at(-2)).toContain('FOR UPDATE');
    expect(sql.at(-1)).toBe('ROLLBACK');
  });

  it('replays a matching committed positive ACK on startup and preserves the result', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    await attempt.claim();
    f.current().observations.push({ ok: true, error_code: null });
    f.results.push({ payload: { state: 'sent', errorCode: null } });
    expect(await new SmsAttemptRepository(f.pool).reconcile()).toBe(1);
    expect(f.current()).toMatchObject({ task: 'sent', command: input.commandId, negative: false, invalidations: 2 });
  });

  it('retains conflicting ACK observations under the task lock', async () => {
    const f = fixture();
    const attempt = f.repo.prepare(input);
    await attempt.claim();
    await attempt.acknowledge(negative);
    await attempt.acknowledge(accepted);
    expect(f.current()).toMatchObject({ task: 'unknown', code: 'SMS_RESULT_CONFLICT', observations: [{ ok: false, error_code: 'CONFLICT' }, { ok: true, error_code: null }] });
    expect(() => f.repo.prepare({ ...input, commandId: 'cmd_1' })).toThrow('Invalid outbound SMS command ID');
    expect(await f.repo.prepare({ ...input, commandId: otherId }).claim()).toBe(false);
  });
});
