import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { transaction } from '../db/pool.js';

const deviceId = /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const serial = /^[A-Za-z0-9._:-]{1,128}$/;
const canonicalToken = /^[A-Za-z0-9_-]{43}$/;
const ttlSeconds = 30;
const field = 'usbAutostart';
const resultSchema = z.enum(['started', 'failed', 'already_running']);
const reportSchema = z.object({
  serial: z.string().regex(serial),
  model: z.string().min(1).max(128).regex(/^[\p{L}\p{N} ._+-]+$/u),
  result: resultSchema,
  detail: z.string().max(512),
}).strict();
const storedSchema = z.object({ serial: z.string().regex(serial), lastResult: resultSchema }).strict();

type Report = z.infer<typeof reportSchema>;
export type UsbAutostartStatus = z.infer<typeof storedSchema> & { lastAt: number };

export function readShizukuConfig(mapping: string | undefined, token: string | undefined) {
  if (mapping === undefined && token === undefined) return null;
  if (!mapping?.trim() || !token || !canonicalToken.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new Error('Invalid Shizuku reporter configuration');
  }
  const devices = new Map<string, string>();
  const ids = new Set<string>();
  for (const item of mapping.split(',')) {
    const [usb, id, ...extra] = item.trim().split('=');
    if (!usb || !id || extra.length || !serial.test(usb) || !deviceId.test(id) || devices.has(usb) || ids.has(id)) {
      throw new Error('Invalid Shizuku device mapping');
    }
    devices.set(usb, id);
    ids.add(id);
  }
  return { devices, tokenDigest: digest(token) };
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const normalizedModel = (model: string) => model.trim().replace(/[\s_]+/g, '_');

export function projectShizukuAutostart(row: { value: unknown; observed_at: Date; received_at: Date; ttl_sec: number } | undefined, now: number): UsbAutostartStatus | null {
  if (!row) return null;
  const value = storedSchema.safeParse(row.value);
  const at = row.observed_at.getTime();
  const received = row.received_at.getTime();
  if (!value.success || !Number.isFinite(at) || !Number.isFinite(received) || at < 0 || at > now || at > received ||
    !Number.isInteger(row.ttl_sec) || row.ttl_sec < 1 || now - at > Math.min(row.ttl_sec, ttlSeconds) * 1000) return null;
  return { ...value.data, lastAt: at };
}

export function setShizukuAutostart(pool: pg.Pool, id: string, report: Report): Promise<boolean> {
  return transaction(pool, async client => {
    const device = await client.query<{ model: string | null }>(
      'SELECT model FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE', [id],
    );
    const model = device.rows[0]?.model;
    if (!model || report.model === 'unknown' || normalizedModel(model) !== normalizedModel(report.model)) return false;
    // A host observation is independent from the APK Binder check and does
    // not refresh the device connection, role, or capability evidence.
    const value = { serial: report.serial, lastResult: report.result };
    const saved = await client.query(
      `INSERT INTO device_status(device_id,field,value,observed_at,ttl_sec,received_at)
       SELECT $1,$2,$3::jsonb,at,$4::int,at FROM (SELECT clock_timestamp() AS at) sample WHERE true
       ON CONFLICT(device_id,field) DO UPDATE SET value=EXCLUDED.value,
        observed_at=EXCLUDED.observed_at,ttl_sec=EXCLUDED.ttl_sec,received_at=EXCLUDED.received_at`,
      [id, field, JSON.stringify(value), ttlSeconds],
    );
    if (saved.rowCount !== 1) throw new Error('Shizuku observation not recorded');
    return true;
  });
}

export function registerShizukuReport(app: FastifyInstance, config: NonNullable<ReturnType<typeof readShizukuConfig>>,
  record: (id: string, report: Report) => Promise<boolean>, isRunning: () => boolean): void {
  const error = (code: string) => ({ error: { code, message: code, details: null } });
  app.post('/internal/shizuku-autostart', { bodyLimit: 4096 }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const remote = request.raw.socket.remoteAddress;
    if (remote !== '127.0.0.1' && remote !== '::ffff:127.0.0.1') return reply.code(404).send(error('NOT_FOUND'));
    const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(request.headers.authorization ?? '')?.[1];
    if (!token || !timingSafeEqual(digest(token), config.tokenDigest)) return reply.code(401).send(error('UNAUTHORIZED'));
    if (!isRunning()) return reply.code(503).send(error('INTERNAL'));
    const body = reportSchema.safeParse(request.body);
    if (!body.success) return reply.code(400).send(error('BAD_REQUEST'));
    const id = config.devices.get(body.data.serial);
    if (!id || !await record(id, body.data)) return reply.code(404).send(error('NOT_FOUND'));
    return { data: {} };
  });
}
