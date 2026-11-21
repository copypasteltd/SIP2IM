import { randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { projectShizukuAutostart, readShizukuConfig, registerShizukuReport, setShizukuAutostart } from '../src/devices/shizuku-report.js';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const report = { serial: 'lab-device', model: 'Test_Model', result: 'already_running' as const, detail: '' };

it('accepts authenticated local reports only for an explicitly enrolled serial', async () => {
  const token = randomBytes(32).toString('base64url');
  const config = readShizukuConfig('lab-device=' + deviceId, token)!;
  const record = vi.fn(async () => true);
  const app = Fastify();
  registerShizukuReport(app, config, record, () => true);
  try {
    const submit = (remoteAddress: string, payload: unknown, credential?: string) => app.inject({
      method: 'POST', url: '/internal/shizuku-autostart', remoteAddress, payload: JSON.stringify(payload),
      headers: { 'content-type': 'application/json', ...(credential ? { authorization: 'Bearer ' + credential } : {}) },
    });
    expect((await submit('192.0.2.5', report, token)).statusCode).toBe(404);
    expect((await submit('127.0.0.1', report)).statusCode).toBe(401);
    expect((await submit('127.0.0.1', { ...report, other: 'value' }, token)).statusCode).toBe(400);
    expect((await submit('127.0.0.1', { ...report, serial: 'other-device' }, token)).statusCode).toBe(404);
    expect(record).not.toHaveBeenCalled();
    const accepted = await submit('127.0.0.1', report, token);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.headers['cache-control']).toBe('no-store');
    expect(record).toHaveBeenCalledExactlyOnceWith(deviceId, report);
    expect(() => readShizukuConfig('a=' + deviceId + ',b=' + deviceId, token)).toThrow('Invalid Shizuku device mapping');
  } finally { await app.close(); }
});

it('stores only the enrolled device observation and expires stale or future evidence', async () => {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => {
    if (sql.includes('SELECT model')) return { rows: [{ model: 'Test Model' }], rowCount: 1 };
    return { command: sql, rows: [], rowCount: 1 };
  });
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool;
  await expect(setShizukuAutostart(pool, deviceId, { ...report, model: 'wrong' })).resolves.toBe(false);
  await expect(setShizukuAutostart(pool, deviceId, report)).resolves.toBe(true);
  const writes = query.mock.calls.filter(([sql]) => sql.includes('INSERT INTO device_status'));
  expect(writes).toHaveLength(1);
  expect(writes[0]?.[1]).toEqual([deviceId, 'usbAutostart', JSON.stringify({ serial: report.serial, lastResult: report.result }), 30]);
  const row = { value: { serial: report.serial, lastResult: report.result }, observed_at: new Date(1000), received_at: new Date(1000), ttl_sec: 30 };
  expect(projectShizukuAutostart(row, 1000)).toEqual({ ...row.value, lastAt: 1000 });
  expect(projectShizukuAutostart(row, 31001)).toBeNull();
  expect(projectShizukuAutostart(row, 999)).toBeNull();
});
