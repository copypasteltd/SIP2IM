import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, expect, it, vi } from 'vitest';
import type pg from 'pg';
import type { AlertEvent } from '../src/alerts/episodes.js';
import { TransactionCommitUnknown } from '../src/db/pool.js';
import { projectShizukuAutostart, readShizukuConfig, registerShizukuReport, setShizukuAutostart } from '../src/devices/shizuku-report.js';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const report = { serial: 'lab-device', model: 'Test_Model', result: 'already_running' as const, detail: '' };
const failure = { ...report, result: 'failed' as const, detail: 'consecutive failures: 999 (fixture only)' };
const target = ['shizuku_autostart_failed', 'device', deviceId];

afterEach(() => vi.useRealTimers());

it('accepts authenticated local reports only for an explicitly enrolled serial', async () => {
  const token = randomBytes(32).toString('base64url');
  const config = readShizukuConfig('lab-device=' + deviceId, token)!;
  const record = vi.fn(async () => true);
  const app = Fastify();
  let running = true;
  registerShizukuReport(app, config, record, () => running);
  try {
    const submit = (remoteAddress: string, payload: unknown, credential?: string) => app.inject({
      method: 'POST', url: '/internal/shizuku-autostart', remoteAddress, payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '127.0.0.1',
        ...(credential ? { authorization: 'Bearer ' + credential } : {}) },
    });
    expect((await submit('192.0.2.5', report, token)).statusCode).toBe(404);
    expect((await submit('127.0.0.1', report)).statusCode).toBe(401);
    expect((await submit('127.0.0.1', report, randomBytes(32).toString('base64url'))).statusCode).toBe(401);
    expect((await submit('127.0.0.1', { ...report, other: 'value' }, token)).statusCode).toBe(400);
    expect((await submit('127.0.0.1', { ...report, result: 'unknown' }, token)).statusCode).toBe(400);
    expect((await submit('127.0.0.1', { ...report, serial: 'other-device' }, token)).statusCode).toBe(404);
    running = false;
    expect((await submit('127.0.0.1', failure, token)).statusCode).toBe(503);
    expect(record).not.toHaveBeenCalled();
    running = true;
    const accepted = await submit('::ffff:127.0.0.1', report, token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ data: {} });
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(record).toHaveBeenCalledExactlyOnceWith(deviceId, report);
    expect(() => readShizukuConfig('a=' + deviceId + ',b=' + deviceId, token)).toThrow('Invalid Shizuku device mapping');
  } finally { await app.close(); }
});

type StatusRow = NonNullable<Parameters<typeof projectShizukuAutostart>[0]>;
type Report = Parameters<typeof setShizukuAutostart>[2];
type AlertRow = {
  id: string;
  type: string;
  subjectType: string;
  subjectId: string;
  severity: 'warning';
  state: 'open' | 'acked' | 'resolved';
  detail: Record<string, never>;
  resolvedAt: number | null;
};

function statusRow(at: number, value: unknown, ttl = 30): StatusRow {
  return { value, observed_at: new Date(at), received_at: new Date(at), ttl_sec: ttl };
}

// In-memory transaction fixture. An alert action must run after the status write
// on the same client and while the parent row lock is held.
function repositoryFixture() {
  vi.useFakeTimers({ toFake: ['Date'] });
  const committed = { status: undefined as StatusRow | undefined, alerts: [] as AlertRow[] };
  const controls = { enabled: true, revoked: false, lockDelay: 0, failAlertWrite: false, loseCommitReply: false };
  let tx: (typeof committed & { locked: boolean; wroteStatus: boolean }) | undefined;
  const rows = (...items: unknown[]) => ({ rowCount: items.length, rows: items });
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql === 'BEGIN') {
      expect(tx).toBeUndefined();
      tx = { ...structuredClone(committed), locked: false, wroteStatus: false };
      return { command: 'BEGIN' };
    }
    if (sql === 'ROLLBACK') {
      tx = undefined;
      return { command: 'ROLLBACK' };
    }
    if (!tx) throw new Error('Report query outside a transaction');
    if (sql === 'COMMIT') {
      committed.status = tx.status;
      committed.alerts = tx.alerts;
      tx = undefined;
      if (controls.loseCommitReply) throw new Error('Lost COMMIT response');
      return { command: 'COMMIT' };
    }
    if (sql === 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return { command: 'SET' };
    if (sql.startsWith('SELECT model')) {
      expect(sql).toContain('enabled=true AND revoked_at IS NULL FOR UPDATE');
      expect(args).toEqual([deviceId]);
      vi.setSystemTime(Date.now() + controls.lockDelay);
      if (!controls.enabled || controls.revoked) return rows();
      tx.locked = true;
      return rows({ model: 'Test Model' });
    }
    if (!tx.locked) throw new Error('Report query without the device lock');
    if (sql.includes('FROM device_status')) {
      expect(args).toEqual([deviceId, 'usbAutostart']);
      return tx.status ? rows(tx.status) : rows();
    }
    if (sql.startsWith('INSERT INTO device_status')) {
      expect(args.slice(0, 2)).toEqual([deviceId, 'usbAutostart']);
      expect(args[4]).toBe(30);
      tx.status = statusRow((args[3] as Date).getTime(), JSON.parse(String(args[2])));
      tx.wroteStatus = true;
      return { rowCount: 1 };
    }
    expect(tx.wroteStatus).toBe(true);
    expect(args.slice(0, 3)).toEqual(target);
    const live = tx.alerts.find(alert => alert.resolvedAt === null);
    if (sql.startsWith('INSERT INTO alert')) {
      if (controls.failAlertWrite) throw new Error('Alert insert failed');
      expect(sql).toContain("'warning','open'");
      expect(sql).toContain("state IN ('open','acked') AND resolved_at IS NULL");
      expect(args).toEqual([...target, expect.stringMatching(/^alr_/), false]);
      if (live) return rows();
      const alert: AlertRow = { id: String(args[3]), type: target[0]!, subjectType: 'device',
        subjectId: deviceId, severity: 'warning', state: 'open', detail: {}, resolvedAt: null };
      tx.alerts.push(alert);
      return rows(alert);
    }
    if (sql.startsWith('UPDATE alert')) {
      expect(sql).toContain("CASE WHEN state='open' THEN 'resolved' ELSE state END");
      expect(args).toEqual(target);
      if (!live) return rows();
      if (live.state === 'open') live.state = 'resolved';
      live.resolvedAt = Date.now();
      return rows(live);
    }
    throw new Error('Unexpected fixture query: ' + sql);
  });
  const release = vi.fn();
  const pool = { connect: async () => ({ query, release }) } as unknown as pg.Pool;
  const notify = vi.fn(async (_event: AlertEvent) => {});
  const submit = (at: number, input: Report = failure) => {
    vi.setSystemTime(at);
    return setShizukuAutostart(pool, deviceId, input, notify);
  };
  return { committed, controls, notify, query, release, submit };
}

it('projects the original status fields and rejects stale or future evidence', () => {
  const row = statusRow(1000, { serial: failure.serial, lastResult: failure.result, consecutiveFailures: 2 });
  const expected = { serial: failure.serial, lastResult: failure.result, lastAt: 1000 };
  expect(projectShizukuAutostart(row, 1000)).toEqual(expected);
  expect(projectShizukuAutostart(statusRow(1000, { serial: failure.serial, lastResult: failure.result }), 1000)).toEqual(expected);
  expect(projectShizukuAutostart(row, 31000)).toEqual(expected);
  expect(projectShizukuAutostart({ ...row, ttl_sec: 300 }, 31001)).toBeNull();
  expect(projectShizukuAutostart(row, 999)).toBeNull();
  expect(projectShizukuAutostart({ ...row, received_at: new Date(1001) }, 1000)).toBeNull();
  expect(projectShizukuAutostart({ ...row, received_at: new Date(999) }, 1000)).toBeNull();
});

it('does not count model mismatches, unknown models, disabled devices or revoked devices', async () => {
  const f = repositoryFixture();
  await expect(f.submit(1000, { ...failure, model: 'wrong' })).resolves.toBe(false);
  await expect(f.submit(11000, { ...failure, model: 'unknown' })).resolves.toBe(false);
  f.controls.enabled = false;
  await expect(f.submit(21000)).resolves.toBe(false);
  f.controls.enabled = true;
  f.controls.revoked = true;
  await expect(f.submit(31000, report)).resolves.toBe(false);
  expect(f.committed).toEqual({ status: undefined, alerts: [] });
  expect(f.notify).not.toHaveBeenCalled();
});

it('raises on the third failure, retains acknowledgement until recovery, and reopens on a later episode', async () => {
  const f = repositoryFixture();
  await expect(f.submit(1000)).resolves.toBe(true);
  expect(f.committed.status?.value).toEqual({ serial: failure.serial, lastResult: 'failed', consecutiveFailures: 1 });
  await f.submit(11000);
  expect(f.committed.alerts).toEqual([]);
  expect(f.notify).not.toHaveBeenCalled();
  await f.submit(21000);
  expect(f.committed.status?.value).toEqual({ serial: failure.serial, lastResult: 'failed', consecutiveFailures: 3 });
  expect(f.committed.alerts).toEqual([{ id: expect.stringMatching(/^alr_/), type: target[0], subjectType: 'device',
    subjectId: deviceId, severity: 'warning', state: 'open', detail: {}, resolvedAt: null }]);
  expect(f.notify).toHaveBeenCalledExactlyOnceWith({ type: 'alert.raised', data: f.committed.alerts[0] });
  expect(f.query).toHaveBeenLastCalledWith('COMMIT');
  expect(f.query.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.notify.mock.invocationCallOrder[0]!);
  expect(f.release.mock.invocationCallOrder.at(-1)!).toBeLessThan(f.notify.mock.invocationCallOrder[0]!);
  f.committed.alerts[0]!.state = 'acked';
  await f.submit(31000);
  expect(f.committed.status?.value).toMatchObject({ consecutiveFailures: 3 });
  await f.submit(62000);
  expect(f.committed.status?.value).toMatchObject({ consecutiveFailures: 1 });
  expect(f.committed.alerts).toHaveLength(1);
  expect(f.committed.alerts[0]).toMatchObject({ state: 'acked', resolvedAt: null });
  expect(f.notify).toHaveBeenCalledTimes(1);

  await f.submit(72000, report);
  expect(f.committed.status?.value).toEqual({ serial: report.serial, lastResult: 'already_running' });
  expect(f.committed.alerts[0]).toMatchObject({ state: 'acked', resolvedAt: 72000 });
  expect(f.notify).toHaveBeenNthCalledWith(2, { type: 'alert.resolved', data: f.committed.alerts[0] });
  for (const at of [82000, 92000, 102000]) await f.submit(at);
  expect(f.committed.alerts).toHaveLength(2);
  expect(f.committed.alerts[1]).toMatchObject({ state: 'open', resolvedAt: null });
  expect(f.committed.alerts[1]?.id).not.toBe(f.committed.alerts[0]?.id);
  expect(f.notify).toHaveBeenNthCalledWith(3, { type: 'alert.raised', data: f.committed.alerts[1] });

  await f.submit(112000, { ...report, result: 'started' });
  expect(f.committed.alerts[1]).toMatchObject({ state: 'resolved', resolvedAt: 112000 });
  expect(f.notify).toHaveBeenNthCalledWith(4, { type: 'alert.resolved', data: f.committed.alerts[1] });
});

it('ignores burst failures without extending their freshness', async () => {
  const f = repositoryFixture();
  await f.submit(1000);
  await expect(f.submit(1000)).resolves.toBe(true);
  await expect(f.submit(2000, { ...failure, detail: 'different body text' })).resolves.toBe(true);
  await f.submit(5999);
  expect(f.committed.status?.observed_at.getTime()).toBe(1000);
  expect(f.committed.status?.value).toMatchObject({ consecutiveFailures: 1 });
  expect(f.committed.alerts).toEqual([]);
  await f.submit(11000);
  expect(f.committed.status?.value).toMatchObject({ consecutiveFailures: 2 });
  await f.submit(21000);
  expect(f.committed.alerts).toHaveLength(1);
});

it.each([
  ['missing legacy counter', statusRow(1000, { serial: report.serial, lastResult: 'failed' })],
  ['invalid counter', statusRow(1000, { serial: report.serial, lastResult: 'failed', consecutiveFailures: 500 })],
  ['expired source', statusRow(1000, { serial: report.serial, lastResult: 'failed', consecutiveFailures: 2 }, 5)],
  ['different enrolled serial', statusRow(1000, { serial: 'previous-lab-device', lastResult: 'failed', consecutiveFailures: 2 })],
  ['previous recovery', statusRow(1000, { serial: report.serial, lastResult: 'started' })],
])('starts with one failure after %s', async (_reason, previous) => {
  const f = repositoryFixture();
  f.committed.status = previous;
  await f.submit(11000);
  expect(f.committed.status?.value).toEqual({ serial: report.serial, lastResult: 'failed', consecutiveFailures: 1 });
  expect(f.committed.alerts).toEqual([]);
  expect(f.notify).not.toHaveBeenCalled();
});

it('leaves an episode open on stale, out-of-order or future-dated evidence', async () => {
  const f = repositoryFixture();
  for (const at of [1000, 11000, 21000]) await f.submit(at);
  await expect(f.submit(20000, report)).resolves.toBe(true);
  f.controls.lockDelay = 31000;
  await expect(f.submit(31000, report)).resolves.toBe(true);
  f.controls.lockDelay = -1000;
  await expect(f.submit(64000, report)).resolves.toBe(true);
  expect(f.committed.status?.observed_at.getTime()).toBe(21000);
  expect(f.committed.alerts[0]).toMatchObject({ state: 'open', resolvedAt: null });
  expect(f.notify).toHaveBeenCalledTimes(1);
  f.controls.lockDelay = 4000;
  await f.submit(65000, report);
  expect(f.committed.status?.observed_at.getTime()).toBe(65000);
  expect(f.committed.alerts[0]).toMatchObject({ state: 'resolved' });
});

it('updates the observation and episode atomically and only notifies confirmed commits', async () => {
  const f = repositoryFixture();
  await f.submit(1000);
  await f.submit(11000);
  f.controls.failAlertWrite = true;
  await expect(f.submit(21000)).rejects.toThrow('Alert insert failed');
  expect(f.committed.status?.observed_at.getTime()).toBe(11000);
  expect(f.committed.alerts).toEqual([]);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.query).toHaveBeenLastCalledWith('ROLLBACK');

  f.controls.failAlertWrite = false;
  f.controls.loseCommitReply = true;
  await expect(f.submit(31000)).rejects.toBeInstanceOf(TransactionCommitUnknown);
  expect(f.committed.alerts).toHaveLength(1);
  expect(f.notify).not.toHaveBeenCalled();
  expect(f.release).toHaveBeenLastCalledWith(true);
  f.controls.loseCommitReply = false;
  await expect(f.submit(41000)).resolves.toBe(true);
  expect(f.committed.alerts).toHaveLength(1);
  expect(f.notify).not.toHaveBeenCalled();

  f.notify.mockRejectedValueOnce(new Error('Admin fanout unavailable'));
  await expect(f.submit(51000, report)).resolves.toBe(true);
  expect(f.committed.alerts[0]).toMatchObject({ state: 'resolved' });
  expect(f.notify).toHaveBeenCalledExactlyOnceWith({ type: 'alert.resolved', data: f.committed.alerts[0] });
});
