import {createHash, randomUUID} from 'node:crypto';
import type pg from 'pg';
import {ulid} from 'ulid';
import {canonicalSmsEnvelope, encodeSmsCustodyEnvelope, isParsedSmsEnvelope, smsQuarantineReasons, type ParsedSmsEnvelope, type SmsQuarantineReason} from '../devices/sms-quarantine-envelope.js';
import {decodeQuarantinePayload, MAX_SMS_QUARANTINE_BYTES, SMS_QUARANTINE_ENCODING} from '../devices/sms-quarantine-codec.js';

export const SMS_QUARANTINE_MARKER = 'sms.received.quarantined';
export const SMS_QUARANTINE_ALERT = 'sms_receive_quarantined';
const deviceIdPattern = /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const durableDatabase = `NOT pg_is_in_recovery()
  AND current_setting('transaction_read_only')='off'
  AND current_setting('server_encoding')='UTF8' AND current_setting('client_encoding')='UTF8'
  AND current_setting('fsync')='on' AND current_setting('session_replication_role')='origin'`;

export async function canConfirmSmsCustody(client: pg.PoolClient): Promise<boolean> {
  const result = await client.query<{ready: boolean}>(`SELECT ${durableDatabase}
    AND current_setting('synchronous_commit')='on' AS ready`);
  return result.rows.length === 1 && result.rows[0]?.ready === true;
}

export function isQuarantineDeviceId(value: unknown): value is string {
  return typeof value === 'string' && value.length === 30 && deviceIdPattern.test(value);
}

export interface QuarantineEvidence {
  eventId: string;
  deviceTsMs: string;
  encoding: string;
  reason: string;
  payloadLength: number;
  payload: Buffer | null;
  digest: Buffer | null;
}

function digest(payload: Buffer): Buffer {
  return createHash('sha256').update(payload).digest();
}

/** Shared by exact replay and authorized export. Reject inconsistent custody evidence. */
export function decodeSmsCustody(evidence: QuarantineEvidence): ParsedSmsEnvelope | null {
  const {payload, encoding, payloadLength, digest: expectedDigest} = evidence;
  if (encoding !== SMS_QUARANTINE_ENCODING || !Buffer.isBuffer(payload) ||
      payload.length > MAX_SMS_QUARANTINE_BYTES || payload.length !== payloadLength ||
      !Buffer.isBuffer(expectedDigest) || !digest(payload).equals(expectedDigest)) return null;
  try {
    const event = decodeQuarantinePayload(payload);
    if (!isParsedSmsEnvelope(event) || event.id !== evidence.eventId || String(event.ts) !== evidence.deviceTsMs ||
        !encodeSmsCustodyEnvelope(event).equals(payload)) return null;
    const reasons = smsQuarantineReasons(event).join(',');
    const reasonMatches = evidence.reason === 'postgres-index-limit' ? reasons === '' : reasons !== '' && reasons === evidence.reason;
    return reasonMatches ? event : null;
  } catch { return null; }
}

// Anchor child metadata to the global event identity and durable alert.
export const smsCustodyLinks = `
  LEFT JOIN device_event e ON e.id=q.event_id
  LEFT JOIN alert a ON a.id=q.alert_id`;
export const smsCustodyLinked = `COALESCE(e.device_id=q.device_id AND e.type='${SMS_QUARANTINE_MARKER}'
  AND extract(epoch from e.device_ts)*1000=q.device_ts_ms
  AND e.payload=jsonb_build_object('quarantineId',q.id::text)
  AND a.type='${SMS_QUARANTINE_ALERT}' AND a.subject_type='sms_quarantine' AND a.subject_id=q.id::text
  AND NOT EXISTS (SELECT 1 FROM sms_message m WHERE m.event_id=q.event_id), false)`;

// CASE bounds both bytea columns before delivery.
export function smsCustodyBytes(limitParam: '$2' | '$3'): string {
  const bounded = `q.payload_length BETWEEN 2 AND ${limitParam} AND q.payload_length=octet_length(q.payload)`;
  return `CASE WHEN ${bounded} THEN q.payload END AS payload,
          CASE WHEN ${bounded} AND octet_length(q.digest)=32 THEN q.digest END AS digest`;
}

/** The caller holds the device row lock in READ COMMITTED and has confirmed local durability. */
export async function retainSmsCustody(client: pg.PoolClient, deviceId: string, event: ParsedSmsEnvelope, reasons: SmsQuarantineReason[]):
    Promise<'retained' | 'exact-replay' | 'conflict' | 'unavailable'> {
  if (!isQuarantineDeviceId(deviceId)) return 'unavailable';
  let bytes: Buffer;
  try { bytes = encodeSmsCustodyEnvelope(event); } catch { return 'unavailable'; }
  const id = randomUUID();
  const reason = reasons.join(',');
  const marker = await client.query(`INSERT INTO device_event(id,device_id,type,payload,device_ts)
    SELECT $1::text,$2::text,$3::text,jsonb_build_object('quarantineId',$4::text),$5::timestamptz
    WHERE NOT EXISTS (SELECT 1 FROM sms_message WHERE event_id=$1)
    ON CONFLICT(id) DO NOTHING RETURNING id`,
    [event.id,deviceId,SMS_QUARANTINE_MARKER,id,new Date(event.ts)]);
  if (marker.rowCount === 1) {
    const alertId = 'alr_' + ulid();
    const alert = await client.query(`INSERT INTO alert(id,type,subject_type,subject_id,severity,state,detail)
      VALUES ($1,$2,'sms_quarantine',$3,'critical','open',$4)`,
      [alertId,SMS_QUARANTINE_ALERT,id,JSON.stringify({eventId:event.id,deviceId,reasons})]);
    if (alert.rowCount !== 1) throw new Error('SMS_CUSTODY_ALERT_NOT_WRITTEN');
    const record = await client.query(`INSERT INTO sms_received_quarantine
      (id,event_id,device_id,device_ts_ms,reason,encoding,payload,payload_length,digest,alert_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id,event.id,deviceId,event.ts,reason,SMS_QUARANTINE_ENCODING,bytes,bytes.length,digest(bytes),alertId]);
    if (record.rowCount !== 1) throw new Error('SMS_CUSTODY_NOT_WRITTEN');
    return 'retained';
  }
  if (marker.rowCount !== 0) throw new Error('SMS_CUSTODY_MARKER_NOT_WRITTEN');
  return readCustodyReplay(client, deviceId, event);
}

export async function compareSmsCustodyReplay(client: pg.PoolClient, deviceId: string, event: ParsedSmsEnvelope):
    Promise<'exact-replay' | 'conflict' | 'unavailable'> {
  return readCustodyReplay(client, deviceId, event);
}

async function readCustodyReplay(client: pg.PoolClient, deviceId: string, event: ParsedSmsEnvelope):
    Promise<'exact-replay' | 'conflict' | 'unavailable'> {
  // Take a new statement snapshot after resolving the unique-index conflict.
  const prior = await client.query<QuarantineEvidence & {linked: boolean}>(`SELECT q.event_id AS "eventId",
    q.device_ts_ms::text AS "deviceTsMs",q.encoding,q.reason,q.payload_length AS "payloadLength",
    ${smsCustodyBytes('$3')}, ${smsCustodyLinked} AS linked
    FROM sms_received_quarantine q ${smsCustodyLinks} WHERE q.event_id=$1 AND q.device_id=$2`,
    [event.id,deviceId,MAX_SMS_QUARANTINE_BYTES]);
  if (prior.rows.length !== 1) return 'conflict';
  const row = prior.rows[0]!;
  const previous = row.linked === true ? decodeSmsCustody(row) : null;
  if (!previous) return 'unavailable';
  // Mirror the normal JSONB numeric equality without changing the retained bytes.
  return canonicalSmsEnvelope(previous).equals(canonicalSmsEnvelope(event)) ? 'exact-replay' : 'conflict';
}

/** Check schema and local durability prerequisites before enabling custody on this pool. */
export async function assertSmsCustodyReady(pool: pg.Pool): Promise<void> {
  try {
    const result = await pool.query<{ready: boolean}>(`SELECT
      ${durableDatabase}
      AND current_setting('server_version_num')::int>=140000
      AND EXISTS (SELECT 1 FROM schema_migration WHERE version=23)
      AND (SELECT count(*)=7 FROM pg_class WHERE relpersistence='p' AND oid IN (
        'device_event'::regclass,'sms_message'::regclass,'sms_incoming_admin_outbox'::regclass,
        'alert'::regclass,'sms_received_quarantine'::regclass,'sms_received_quarantine_access'::regclass,'device'::regclass))
      AND (SELECT count(*)=3 FROM pg_trigger WHERE tgenabled IN ('O','A') AND (
        (tgrelid='sms_received_quarantine'::regclass AND tgname IN ('sms_received_quarantine_links','sms_received_quarantine_append_only'))
        OR (tgrelid='sms_received_quarantine_access'::regclass AND tgname='sms_received_quarantine_access_append_only')))
      AND has_table_privilege('sms_received_quarantine','SELECT') AND has_table_privilege('sms_received_quarantine','INSERT')
      AND has_table_privilege('sms_received_quarantine_access','INSERT')
      AND NOT row_security_active('sms_received_quarantine') AND NOT row_security_active('sms_received_quarantine_access')
      AND has_table_privilege('admin','SELECT') AND has_any_column_privilege('admin','UPDATE')
      AND has_table_privilege('admin_session','SELECT') AND has_any_column_privilege('admin_session','UPDATE') AS ready`);
    if (result.rows.length === 1 && result.rows[0]?.ready === true) return;
  } catch { /* Mask deployment and driver details at the startup boundary. */ }
  throw new Error('SMS_CUSTODY_NOT_READY');
}
