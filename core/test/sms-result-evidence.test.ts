import type pg from 'pg';
import { isDeepStrictEqual } from 'node:util';
import { expect, it, vi } from 'vitest';
import { parseDeviceMessage } from '@voipgw/protocol';
import { DeviceEvents } from '../src/devices/events.js';
import { replaySmsResults } from '../src/sms/results.js';

type State = 'accepted' | 'queued' | 'dispatched' | 'sent' | 'failed' | 'delivered' | 'unknown';
type Payload = { taskId: string; state: State; errorCode: string | null };
type Evidence = { deviceId: string; event: ReturnType<typeof result> };
const result = (id: string, state: State, errorCode: string | null = null, taskId = 'task') => (
  { v: 1 as const, type: 'sms.result', id, ts: 1, payload: { taskId, state, errorCode } }
);
const conflict = result('callback-conflict', 'unknown', 'SMS_CALLBACK_CONFLICT');
const sticky = { state: 'unknown', code: 'SMS_RESULT_CONFLICT' };

// In-memory transaction fixture for event retention, ownership, and projection.
// The SQL-specific assertions check the guards without starting a database.
function fixture(state: State = 'accepted', code: string | null = null, existing: Evidence[] = []) {
  let saved = { state, code, evidence: structuredClone(existing), invalidations: 0 };
  let draft: typeof saved | undefined;
  let enabled = true;
  const empty = (command?: string) => ({ rows: [], rowCount: 0, command });
  const row = (value: object = {}) => ({ rows: [value], rowCount: 1 });
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === 'BEGIN') { draft = structuredClone(saved); return empty(sql); }
    if (sql === 'COMMIT') { saved = draft!; draft = undefined; return empty(sql); }
    if (sql === 'ROLLBACK') { draft = undefined; return empty(sql); }
    const current = draft!;
    if (sql.startsWith('SET ')) return empty();
    if (sql.startsWith('SELECT id FROM device')) {
      expect(sql).toContain('enabled=true AND revoked_at IS NULL FOR UPDATE');
      return enabled ? row() : empty();
    }
    if (sql.startsWith('SELECT t.id FROM sms_task')) {
      expect(sql).toContain("m.device_id=$2 AND m.direction='out' FOR UPDATE OF t");
      return isDeepStrictEqual(params, ['task', 'device']) ? row() : empty();
    }
    if (sql.startsWith('INSERT INTO device_event')) {
      const [id, deviceId, type, raw, ts] = params as [string, string, string, string, Date];
      if (current.evidence.some(r => r.event.id === id)) return empty();
      current.evidence.push({ deviceId, event: { v: 1, id, type, ts: ts.getTime(), payload: JSON.parse(raw) as Payload } });
      return row();
    }
    if (sql.startsWith('SELECT device_id=$2')) {
      expect(sql).toContain('AND type=$3 AND payload=$4::jsonb AND device_ts=$5');
      const [id, deviceId, type, raw, ts] = params as [string, string, string, string, Date];
      return row({ matches: current.evidence.some(r => r.deviceId === deviceId && r.event.id === id
        && r.event.type === type && r.event.ts === ts.getTime() && isDeepStrictEqual(r.event.payload, JSON.parse(raw))) });
    }
    if (sql.startsWith('SELECT e.payload')) {
      expect(sql).toContain("m.device_id=e.device_id AND m.direction='out'");
      return { rows: current.evidence.filter(r => r.deviceId === 'device' && r.event.type === 'sms.result'
        && r.event.payload.taskId === params[0]).map(r => ({ payload: r.event.payload })) };
    }
    if (sql.includes("error_code='SMS_RESULT_CONFLICT'")) {
      expect(sql).toContain("state IN ('accepted','unknown','failed','sent','delivered')");
      expect(sql).toContain("state<>'unknown' OR error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT'");
      expect(sql).toContain('$4::boolean OR negative_ack OR local_failure OR (legacy_failure AND $2::boolean)');
      expect(sql).toContain("OR ($2::boolean AND (state='failed' OR $3::boolean))");
      expect(sql).toContain("OR ($3::boolean AND state IN ('sent','delivered'))");
      const [, submitted, failed, callback] = params;
      if (current.state === 'queued' || current.state === 'dispatched') return empty();
      if (current.state === 'unknown' && current.code === sticky.code) return empty();
      if (!(callback || (submitted && (current.state === 'failed' || failed))
        || (failed && ['sent', 'delivered'].includes(current.state)))) return empty();
      current.state = 'unknown';
      current.code = sticky.code;
      return row();
    }
    if (sql.startsWith('UPDATE sms_task SET state=$2')) {
      expect(sql).toContain("error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT'");
      expect(sql).toContain("state='unknown' AND error_code IS NULL AND $3::text IS NOT NULL");
      const [, next, reason] = params as [string, State, string | null];
      const { state: prior, code: priorCode } = current;
      if (priorCode === sticky.code) return empty();
      if (!((['accepted', 'unknown'].includes(prior) && ['sent', 'failed'].includes(next))
        || (prior === 'sent' && next === 'delivered')
        || (next === 'unknown' && (prior === 'accepted' || (prior === 'unknown' && priorCode === null && reason !== null))))) return empty();
      current.state = next;
      current.code = reason;
      return row();
    }
    if (sql.startsWith('INSERT INTO sms_maintenance_admin_invalidation')) { current.invalidations++; return row(); }
    throw new Error('Unexpected query: ' + sql);
  });
  const client = { query, release() {} } as unknown as pg.PoolClient;
  const pool = { connect: async () => client } as unknown as pg.Pool;
  return {
    handle: (event: Evidence['event'], deviceId = 'device') => new DeviceEvents(pool).handle(deviceId, event),
    current: () => saved,
    query,
    disable() { enabled = false; },
    async settleEarlyResult() {
      await query('BEGIN');
      draft!.state = 'accepted';
      await replaySmsResults(client, 'task', true);
      await query('COMMIT');
    },
  };
}

it('parses the callback marker through the existing wire result schema', () => {
  const wire = result('evt_01ARZ3NDEKTSV4RRFFQ69G5FAV', 'unknown', 'SMS_CALLBACK_CONFLICT', 'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW');
  expect(parseDeviceMessage(wire, 'event')).toEqual(wire);
  expect(() => parseDeviceMessage({ ...wire, payload: { ...wire.payload, errorCode: 'SMS_RESULT_CONFLICT' } }, 'event')).toThrow();
});

it.each(['sent', 'failed', 'delivered'] as const)('retains a callback contradiction with %s in either arrival order', async state => {
  const terminal = result('terminal', state);
  for (const events of [[conflict, terminal], [terminal, conflict]]) {
    const f = fixture(state === 'delivered' ? 'sent' : 'accepted');
    for (const event of events) expect(await f.handle(event)).toBe('inserted');
    expect(f.current()).toMatchObject(sticky);
    const after = structuredClone(f.current());
    for (const event of [...events].reverse()) expect(await f.handle(event)).toBe('duplicate');
    expect(f.current()).toEqual(after);
    expect(await f.handle(result('later-failed', 'failed'))).toBe('inserted');
    expect(await f.handle(result('later-delivered', 'delivered'))).toBe('inserted');
    expect(await f.handle(result('later-unknown', 'unknown'))).toBe('inserted');
    expect(f.current()).toMatchObject({ ...sticky, invalidations: after.invalidations });
    expect(f.current().evidence.map(r => r.event)).toEqual([...events, result('later-failed', 'failed'),
      result('later-delivered', 'delivered'), result('later-unknown', 'unknown')]);
  }
});

it.each([
  ['sent', 'failed'], ['delivered', 'failed'], ['failed', 'sent'], ['failed', 'delivered'],
] as const)('compares a persisted %s with new %s even without the original event', async (prior, incoming) => {
  const f = fixture(prior);
  expect(await f.handle(result('terminal', incoming))).toBe('inserted');
  expect(f.current()).toMatchObject({ ...sticky, invalidations: 1 });
});

it('retains the persisted local conflict with no retained result history', async () => {
  const f = fixture('unknown', sticky.code);
  expect(await f.handle(result('late', 'sent'))).toBe('inserted');
  expect(f.current()).toMatchObject({ ...sticky, invalidations: 0 });
});

it('reprojects a previously stored callback marker only after an exact replay', async () => {
  const f = fixture('delivered', null, [{ deviceId: 'device', event: conflict }]);
  expect(await f.handle({ ...conflict, ts: 2 })).toBe('rejected');
  expect(await f.handle(result(conflict.id, 'unknown'))).toBe('rejected');
  expect(f.current()).toMatchObject({ state: 'delivered', invalidations: 0 });
  expect(await f.handle(conflict)).toBe('duplicate');
  expect(await f.handle(conflict)).toBe('duplicate');
  expect(f.current()).toMatchObject({ ...sticky, invalidations: 1, evidence: [{ deviceId: 'device', event: conflict }] });
});

it('enriches a plain unknown with partial-send detail and allows later determinate evidence', async () => {
  const f = fixture();
  const plain = result('plain', 'unknown');
  const partial = result('partial', 'unknown', 'SMS_PARTIAL_SEND');
  expect(await f.handle(plain)).toBe('inserted');
  expect(f.current()).toMatchObject({ state: 'unknown', code: null });
  expect(await f.handle(partial)).toBe('inserted');
  expect(f.current()).toMatchObject({ state: 'unknown', code: 'SMS_PARTIAL_SEND', invalidations: 2 });
  expect(await f.handle(plain)).toBe('duplicate');
  expect(await f.handle(partial)).toBe('duplicate');
  expect(f.current()).toMatchObject({ state: 'unknown', code: 'SMS_PARTIAL_SEND', invalidations: 2 });
  expect(await f.handle(result('terminal', 'failed', 'SMS_SEND_FAILED'))).toBe('inserted');
  expect(f.current()).toMatchObject({ state: 'failed', code: 'SMS_SEND_FAILED', invalidations: 3 });
});

it.each(['sent', 'delivered', 'failed'] as const)('preserves %s under ordinary and partial unknowns', async state => {
  const f = fixture(state);
  expect(await f.handle(result('plain', 'unknown'))).toBe('inserted');
  expect(await f.handle(result('partial', 'unknown', 'SMS_PARTIAL_SEND'))).toBe('inserted');
  expect(f.current()).toMatchObject({ state, code: null, invalidations: 0 });
});

it('stores early conflict evidence and projects it under the later task settlement', async () => {
  const f = fixture('dispatched');
  expect(await f.handle(conflict)).toBe('inserted');
  expect(f.current()).toMatchObject({ state: 'dispatched', invalidations: 0, evidence: [{ deviceId: 'device', event: conflict }] });
  await f.settleEarlyResult();
  expect(f.current()).toMatchObject({ ...sticky, invalidations: 1 });
});

it('ignores stored evidence from another device or task when replaying a result', async () => {
  const f = fixture('sent', null, [
    { deviceId: 'other-device', event: conflict },
    { deviceId: 'device', event: result('different-task', 'unknown', 'SMS_CALLBACK_CONFLICT', 'other-task') },
  ]);
  expect(await f.handle(result('real', 'unknown'))).toBe('inserted');
  expect(f.current()).toMatchObject({ state: 'sent', code: null, invalidations: 0 });
  expect(f.current().evidence).toHaveLength(3);
});

it('requires active device ownership and the exact callback evidence pair before inserting', async () => {
  const f = fixture();
  expect(await f.handle(conflict, 'other-device')).toBe('rejected');
  expect(await f.handle(result('missing', 'unknown', 'SMS_CALLBACK_CONFLICT', 'missing-task'))).toBe('rejected');
  expect(await f.handle(result('mispaired', 'failed', 'SMS_CALLBACK_CONFLICT'))).toBe('rejected');
  expect(await f.handle(result('reserved', 'unknown', 'SMS_RESULT_CONFLICT'))).toBe('rejected');
  f.disable();
  expect(await f.handle(conflict)).toBe('rejected');
  expect(f.query.mock.calls.some(([sql]) => sql.startsWith('INSERT INTO device_event'))).toBe(false);
});
