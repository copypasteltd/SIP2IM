import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { DeviceEvents } from '../src/devices/events.js';
import { SmsMaintenanceInvalidation } from '../src/sms/maintenance-invalidation.js';

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; };
const empty = (command?: string) => ({ rows: [], rowCount: 0, command });

it('releases its read client before fanout and cannot delete a newer marker for the same task', async () => {
  let version: string | undefined = '2026-01-01 00:00:00.000001+00';
  let state = 'dispatched';
  let held = false;
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') return empty(sql);
    if (sql.startsWith('SELECT o.task_id')) return version ? { rows: [{ taskId: 'task', version }], rowCount: 1 } : empty();
    if (sql.startsWith('SELECT m.id AS')) return { rows: [{ smsMessageId: 'message', task: { state } }], rowCount: 1 };
    if (sql.startsWith('DELETE FROM')) {
      if (values?.[1] !== version) return empty();
      version = undefined;
      return { rows: [], rowCount: 1 };
    }
    return empty();
  });
  const pool = { connect: async () => {
    expect(held).toBe(false); held = true;
    return { query, release() { held = false; } };
  }} as unknown as pg.Pool;
  const seen = deferred<void>(), release = deferred<void>();
  const publish = vi.fn(async (_type: string, data: unknown) => {
    expect(held).toBe(false);
    if ((data as { task: { state: string } }).task.state === 'dispatched') { seen.resolve(); await release.promise; }
  });
  const worker = new SmsMaintenanceInvalidation(pool, publish);
  const flush = worker.flush();
  await seen.promise;
  state = 'accepted'; version = '2026-01-01 00:00:00.000002+00';
  release.resolve(); await flush;
  expect(publish.mock.calls.map(([,data]) => (data as {task:{state:string}}).task.state)).toEqual(['dispatched','accepted']);
  const deletes = query.mock.calls.filter(([sql]) => sql.startsWith('DELETE FROM'));
  expect(deletes).toEqual([
    [expect.stringContaining('created_at=$2::timestamptz'), ['task','2026-01-01 00:00:00.000001+00']],
    [expect.stringContaining('created_at=$2::timestamptz'), ['task','2026-01-01 00:00:00.000002+00']],
  ]);
  expect(version).toBeUndefined();
});

it('does not swallow a wake in the empty-read settlement microtask gap', async () => {
  let pending = false, inject = true;
  let subsequent: Promise<void> | undefined;
  const woken = deferred<void>();
  const query = vi.fn(async (sql: string) => {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') return empty(sql);
    if (sql.startsWith('SELECT o.task_id')) return pending ? { rows: [{ taskId:'task', version:'version' }], rowCount:1 } : empty();
    if (sql.startsWith('SELECT m.id AS')) return { rows:[{smsMessageId:'message', task:{state:'failed'}}], rowCount:1 };
    if (sql.startsWith('DELETE FROM')) pending = false;
    return empty();
  });
  const pool = { connect: async () => ({ query, release() {
    if (!inject) return;
    inject = false;
    // Leave the transaction and batch continuations ahead of this wake; it lands
    // after run() observed the empty read but before an outer .finally() would run.
    queueMicrotask(() => queueMicrotask(() => queueMicrotask(() => {
      pending = true;
      subsequent = worker.flush();
      woken.resolve();
    })));
  } }) } as unknown as pg.Pool;
  const publish = vi.fn(async () => {});
  const worker = new SmsMaintenanceInvalidation(pool,publish);
  await worker.flush();
  await woken.promise;
  await subsequent;
  expect(publish).toHaveBeenCalledOnce();
  expect(pending).toBe(false);
});

it.each([false,true])('persists an invalidation with the device result only when its projection changes (changes=%s)', async changes => {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql === 'COMMIT' || sql === 'ROLLBACK') return empty(sql);
    if (sql.startsWith('SELECT id FROM device') || sql.startsWith('SELECT t.id FROM sms_task')) return { rows: [{ id:'task' }], rowCount: 1 };
    if (sql.startsWith('INSERT INTO device_event')) return { rows: [{ id:'evt' }], rowCount: 1 };
    if (sql.startsWith('SELECT e.payload')) return { rows: [{ payload: { state:'sent', errorCode:null } }], rowCount: 1 };
    if (sql.startsWith('UPDATE sms_task SET state=$2')) return { rows: [], rowCount: changes ? 1 : 0 };
    return empty();
  });
  const events = new DeviceEvents({connect:async()=>({query,release(){}})} as unknown as pg.Pool);
  expect(await events.handle('device',{id:'event',ts:1,type:'sms.result',payload:{taskId:'task',state:'sent',errorCode:null}})).toBe('inserted');
  const marker = query.mock.calls.filter(([sql]) => sql.startsWith('INSERT INTO sms_maintenance_admin_invalidation'));
  expect(marker).toHaveLength(changes ? 1 : 0);
  if (changes) {
    expect(marker[0]).toEqual([expect.stringContaining("created_at+interval '1 microsecond'"), ['task']]);
    expect(query.mock.calls.at(-2)).toBe(marker[0]);
    expect(query.mock.calls.at(-1)).toEqual(['COMMIT']);
  }
});
