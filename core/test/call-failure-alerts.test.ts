import type pg from 'pg';
import { adminAlert } from '@voipgw/protocol';
import { expect, it, vi } from 'vitest';
import { CallFailureAlerts } from '../src/calls/failure-alerts.js';

type Call = {
  id: string; state: string; end_cause: string | null;
  projectedLegCause?: string | null;
};
type Alert = {
  id: string; type: string; subjectType: string; subjectId: string; severity: 'warning';
  detail: object; firstAt: number; lastAt: number; pushedAt: null; resolvedAt: number | null;
  state: 'open' | 'acked' | 'resolved';
};
const call = (id: string, state: string, end_cause: string | null = null): Call => ({ id, state, end_cause });
const result = (rows: unknown[] = [], command = 'SELECT') => ({ rows, rowCount: rows.length, command });

/** Committed call rows, independent connection-local alert writes, and explicit
 * transaction outcomes only. No database, call transport, or live clock. */
function fixture(seed: Call[]) {
  const calls = new Map(seed.map(c => [c.id, c]));
  const alerts = new Map<string, Alert>();
  const locked = new Set<string>();
  const failedWrites = new Set<string>();
  const uncertainCommits = new Set<string>();
  const lockAttempts: string[] = [];
  const beforeLock = vi.fn<() => void>();
  const release = vi.fn();
  const query = vi.fn(async (sql: string, [limit, cursor]: [number, string?]) => {
    expect(sql.replace(/\s+/g, ' ')).toContain('WITH page AS MATERIALIZED ( SELECT id,state,end_cause FROM call_session');
    expect(sql).toContain('ORDER BY id DESC LIMIT $1');
    expect(sql.includes('WHERE id<$2')).toBe(cursor !== undefined);
    expect(sql).toContain("p.state IN ('unknown','failed')");
    expect(sql).toContain("p.state='ended' AND p.end_cause IN ('network_error','unknown')");
    expect(sql).toContain('NOT EXISTS (SELECT 1 FROM alert a');
    expect(sql).toContain("a.type='call_failed' AND a.subject_type='call_session' AND a.subject_id=p.id");
    const page = [...calls.values()].filter(c => cursor === undefined || c.id < cursor)
      .sort((a, b) => a.id < b.id ? 1 : a.id > b.id ? -1 : 0).slice(0, limit);
    return result(page.map(c => ({ id: c.id, candidate: !alerts.has(c.id) &&
      (['unknown', 'failed'].includes(c.state) || c.state === 'ended' && ['unknown', 'network_error'].includes(c.end_cause ?? '')) })));
  });
  const pool = { query, connect: async () => {
    let active = false;
    let held: string | undefined;
    let pending: Alert | undefined;
    const query = async (sql: string, args: unknown[] = []) => {
      if (sql === 'BEGIN') { active = true; return result([], sql); }
      expect(active).toBe(true);
      if (sql === 'COMMIT') {
        if (pending) alerts.set(pending.subjectId, pending);
        if (held && uncertainCommits.has(held)) throw new Error('lost COMMIT response');
        active = false;
        return result([], sql);
      }
      if (sql === 'ROLLBACK') { active = false; return result([], sql); }
      if (sql.startsWith('SET ')) return result([], 'SET');
      if (sql.startsWith('SELECT state,end_cause FROM call_session')) {
        expect(sql).toContain('WHERE id=$1 FOR NO KEY UPDATE SKIP LOCKED');
        const id = String(args[0]);
        lockAttempts.push(id);
        beforeLock();
        const row = calls.get(id);
        if (!row || locked.has(id)) return result();
        held = id;
        return result([row]);
      }
      if (sql.startsWith('SELECT 1 FROM call_event e JOIN call_leg')) {
        expect(args).toEqual([held]);
        expect(sql).toContain("e.event='device:call.state'");
        expect(sql).toContain("l.state='disconnected' AND l.end_cause='unknown'");
        return result(held && calls.get(held)?.projectedLegCause === 'unknown' ? [{}] : []);
      }
      if (sql.startsWith('INSERT INTO alert(')) {
        expect(held).toBeDefined();
        expect(args.slice(0, 3)).toEqual(['call_failed', 'call_session', held]);
        expect(args[4]).toBe(true); // Use the real helper with its once policy.
        expect(sql).toContain('WHERE NOT EXISTS (SELECT 1 FROM alert');
        const id = String(args[2]);
        if (failedWrites.has(id)) throw new Error('fixture alert insert unavailable');
        if (alerts.has(id)) return result();
        pending = { id: String(args[3]), type: 'call_failed', subjectType: 'call_session', subjectId: id,
          severity: 'warning', detail: {}, state: 'open', firstAt: 1, lastAt: 1, pushedAt: null, resolvedAt: null };
        return result([pending]);
      }
      throw new Error('Unexpected projector SQL: ' + sql);
    };
    return { query, release };
  } } as unknown as pg.Pool;
  const publish = vi.fn(async (type: string, data: unknown) => {
    expect(type).toBe('alert.raised');
    const parsed = adminAlert.parse(data);
    expect(parsed.detail).toEqual({});
    expect(alerts.get(parsed.subjectId)).toEqual(data); // Never before COMMIT.
  });
  const projector = new CallFailureAlerts(pool);
  const sweep = (admit: () => void = () => {}, current = projector) => current.sweep(admit, publish);
  return { calls, alerts, locked, failedWrites, uncertainCommits, beforeLock, lockAttempts, pool, query, release, publish, sweep };
}

it('projects explicit durable outcomes, not ordinary call endings or placeholder causes', async () => {
  const f = fixture([
    call('direct-legacy-insert', 'unknown', 'unknown'), call('startup-recovery', 'unknown', 'unknown'),
    call('transition-without-cause', 'unknown'), call('explicit-failed-state', 'failed'),
    call('terminal-network-error', 'ended', 'network_error'),
    { ...call('terminal-projected-unknown', 'ended', 'unknown'), projectedLegCause: 'unknown' },
    { ...call('terminal-placeholder', 'ended', 'unknown'), projectedLegCause: null },
    call('terminal-unknown-unattributed', 'ended', 'unknown'), call('unarmed-compensation', 'ended'),
    call('inactive-rejecting-placeholder', 'rejecting', 'unknown'), call('not-terminal', 'ending', 'network_error'),
    call('no-classification', 'ended', 'unrecognized-cause'),
    ...['remote_hangup', 'local_hangup', 'local_answered', 'cancelled', 'busy', 'no_answer', 'rejected']
      .map(c => call(c, 'ended', c)),
  ]);
  await f.sweep();
  expect([...f.alerts.keys()].sort()).toEqual([
    'direct-legacy-insert', 'explicit-failed-state', 'startup-recovery', 'terminal-network-error',
    'terminal-projected-unknown', 'transition-without-cause',
  ]);
  expect(f.publish).toHaveBeenCalledTimes(f.alerts.size);
});

it('deduplicates every state of existing alert history, including after worker recreation', async () => {
  const f = fixture(['open', 'acked', 'resolved'].map(id => call(id, 'unknown', 'unknown')));
  await f.sweep();
  f.alerts.get('acked')!.state = 'acked';
  f.alerts.get('resolved')!.state = 'resolved';
  f.alerts.get('resolved')!.resolvedAt = 2;
  await f.sweep();
  await f.sweep(() => {}, new CallFailureAlerts(f.pool));
  expect(f.alerts.size).toBe(3);
  expect(f.lockAttempts).toHaveLength(3);
  expect(f.publish).toHaveBeenCalledTimes(3);
});

it('continues past all-normal pages within the tick bound and wraps for new outcomes', async () => {
  const seed = Array.from({ length: 265 }, (_, i) => call(String(i).padStart(3, '0'), 'ended', 'remote_hangup'));
  seed[2]!.state = 'unknown';
  const f = fixture(seed);
  await f.sweep();
  expect(f.query.mock.calls.map(([, args]) => args)).toEqual([[64], [64, '201'], [64, '137'], [64, '073']]);
  expect(f.lockAttempts).toEqual([]);
  f.calls.get('264')!.state = 'unknown';
  await f.sweep();
  expect(f.query.mock.calls.at(-1)?.[1]).toEqual([64, '009']);
  expect([...f.alerts.keys()]).toEqual(['002']);
  await f.sweep();
  expect([...f.alerts.keys()]).toEqual(['002', '264']);
});

it('rechecks after locking and retries rows temporarily owned by call writers', async () => {
  const f = fixture([call('stale', 'unknown'), call('locked', 'unknown')]);
  f.locked.add('locked');
  f.beforeLock.mockImplementationOnce(() => {
    Object.assign(f.calls.get('stale')!, { state: 'ended', end_cause: 'remote_hangup' });
  });
  await f.sweep();
  expect(f.alerts.size).toBe(0);
  f.locked.delete('locked');
  await f.sweep();
  expect([...f.alerts.keys()]).toEqual(['locked']);
});

it('can retry a failed alert write without touching the call or blocking later candidates', async () => {
  const f = fixture([call('z-failed-insert', 'unknown'), call('a-other', 'unknown')]);
  f.failedWrites.add('z-failed-insert');
  await expect(f.sweep()).rejects.toThrow('Call failure alert projection or publication failed');
  expect(f.release).toHaveBeenCalledWith(true);
  expect(f.calls.get('z-failed-insert')).toEqual(call('z-failed-insert', 'unknown'));
  expect([...f.alerts.keys()]).toEqual(['a-other']);
  f.failedWrites.clear();
  await f.sweep();
  expect([...f.alerts.keys()]).toEqual(['a-other', 'z-failed-insert']);
});

it('does not publish an unconfirmed COMMIT or replay a fanout after a publish failure', async () => {
  const f = fixture([call('z-commit-lost', 'unknown'), call('a-publish-lost', 'unknown')]);
  f.uncertainCommits.add('z-commit-lost');
  f.publish.mockRejectedValueOnce(new Error('fixture publication unavailable'));
  await expect(f.sweep()).rejects.toThrow('Call failure alert projection or publication failed');
  expect(f.alerts.size).toBe(2); // This fixture modeled a lost response to a committed write.
  expect(f.publish.mock.calls).toEqual([['alert.raised', f.alerts.get('a-publish-lost')]]);
  await f.sweep();
  expect(f.publish).toHaveBeenCalledTimes(1);
});

it('rolls back rather than creating an alert once Core ownership is lost', async () => {
  const f = fixture([call('candidate', 'unknown')]);
  let current = true;
  f.beforeLock.mockImplementation(() => { current = false; });
  await expect(f.sweep(() => { if (!current) throw new Error('maintenance admission closed'); }))
    .rejects.toThrow('maintenance admission closed');
  expect(f.alerts.size).toBe(0);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenCalledWith(true);
});
