import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { raiseAlert, resolveAlert, type AlertEvent, type AlertTarget } from '../alerts/episodes.js';
import { transaction } from '../db/pool.js';

const deviceId = /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const serial = /^[A-Za-z0-9._:-]{1,128}$/;
const canonicalToken = /^[A-Za-z0-9_-]{43}$/;
const ttlSeconds = 30;
const failureThreshold = 3;
// The host polls every 10s with variable ADB and delivery times. Suppress
// closely spaced repeat failures while allowing jitter around the poll cadence.
const minFailureSpacingMs = 5_000;
const field = 'usbAutostart';
const resultSchema = z.enum(['started', 'failed', 'already_running']);
const reportSchema = z.object({
  serial: z.string().regex(serial),
  model: z.string().min(1).max(128).regex(/^[\p{L}\p{N} ._+-]+$/u),
  result: resultSchema,
  detail: z.string().max(512),
}).strict();
const statusSchema = z.object({ serial: z.string().regex(serial), lastResult: resultSchema }).strict();
const storedSchema = statusSchema.extend({
  consecutiveFailures: z.number().int().min(1).max(failureThreshold).optional(),
});

type Report = z.infer<typeof reportSchema>;
type StatusRow = { value: unknown; observed_at: Date; received_at: Date; ttl_sec: number };
export type UsbAutostartStatus = z.infer<typeof statusSchema> & { lastAt: number };

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

function readObservation(row: StatusRow | undefined) {
  if (!row || !(row.observed_at instanceof Date) || !(row.received_at instanceof Date)) return null;
  const value = storedSchema.safeParse(row.value);
  const at = row.observed_at.getTime();
  const received = row.received_at.getTime();
  if (!value.success || !Number.isFinite(at) || !Number.isFinite(received) || at < 0 || at > received ||
    !Number.isInteger(row.ttl_sec) || row.ttl_sec < 1) return null;
  return { value: value.data, at, received, expiresAt: at + Math.min(row.ttl_sec, ttlSeconds) * 1000 };
}

export function projectShizukuAutostart(row: StatusRow | undefined, now: number): UsbAutostartStatus | null {
  const observation = readObservation(row);
  if (!observation || !Number.isFinite(now) || now < observation.received || now > observation.expiresAt) return null;
  const { serial, lastResult } = observation.value;
  return { serial, lastResult, lastAt: observation.at };
}

export async function setShizukuAutostart(pool: pg.Pool, id: string, report: Report,
  notify?: (event: AlertEvent) => void | Promise<void>): Promise<boolean> {
  // Sample Core receipt time before any lock wait can age the report. The
  // wire format has no observation ID or host timestamp to identify delayed replays.
  const receivedAt = Date.now();
  const outcome = await transaction<false | { event: AlertEvent | null }>(pool, async client => {
    await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    const device = await client.query<{ model: string | null }>(
      'SELECT model FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE', [id],
    );
    const model = device.rows[0]?.model;
    if (!model || report.model === 'unknown' || normalizedModel(model) !== normalizedModel(report.model)) return false;
    const { rows } = await client.query<StatusRow>(
      'SELECT value,observed_at,received_at,ttl_sec FROM device_status WHERE device_id=$1 AND field=$2', [id, field],
    );
    const previous = readObservation(rows[0]);
    const age = Date.now() - receivedAt;
    if (age < 0 || age > ttlSeconds * 1000 || (previous && receivedAt <= previous.received)) return { event: null };

    const previousFailure = previous && receivedAt <= previous.expiresAt &&
      previous.value.serial === report.serial && previous.value.lastResult === 'failed' ? previous : null;
    const failed = report.result === 'failed';
    if (failed && previousFailure && receivedAt - previousFailure.at < minFailureSpacingMs) return { event: null };
    const priorFailures = previousFailure?.value.consecutiveFailures ?? 0;
    const consecutiveFailures = failed ? Math.min(priorFailures + 1, failureThreshold) : undefined;
    // This host observation is independent from the APK Binder, connection,
    // role and capability evidence. The diagnostic detail is never persisted.
    const value = { serial: report.serial, lastResult: report.result, consecutiveFailures };
    const saved = await client.query(
      `INSERT INTO device_status(device_id,field,value,observed_at,ttl_sec,received_at)
       VALUES ($1,$2,$3::jsonb,$4::timestamptz,$5,$4::timestamptz)
       ON CONFLICT(device_id,field) DO UPDATE SET value=EXCLUDED.value,
        observed_at=EXCLUDED.observed_at,ttl_sec=EXCLUDED.ttl_sec,received_at=EXCLUDED.received_at`,
      [id, field, JSON.stringify(value), new Date(receivedAt), ttlSeconds],
    );
    if (saved.rowCount !== 1) throw new Error('Shizuku observation not recorded');

    const target: AlertTarget = { type: 'shizuku_autostart_failed', subjectType: 'device', subjectId: id };
    if (!failed) return { event: await resolveAlert(client, target) };
    return { event: consecutiveFailures === failureThreshold ? await raiseAlert(client, target) : null };
  });
  if (!outcome) return false;
  if (outcome.event && notify) {
    // The host report is committed. A missed notification can be recovered by a readback.
    try { await notify(outcome.event); } catch { /* Best-effort admin fanout. */ }
  }
  return true;
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
