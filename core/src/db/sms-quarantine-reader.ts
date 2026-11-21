import type pg from 'pg';
import {tokenHash} from '../auth/service.js';
import {transaction} from './pool.js';
import {validPgTimestamp} from '../util/cursor.js';
import type {QuarantineRead, QuarantineRow, RecoverableQuarantineRead, RecoverableQuarantineRow} from '../http/sms-quarantine-inventory.js';
import {canConfirmSmsCustody, decodeSmsCustody, isQuarantineDeviceId, smsCustodyBytes, smsCustodyLinked, smsCustodyLinks, type QuarantineEvidence} from './sms-quarantine-custody.js';
import {MAX_SMS_QUARANTINE_BYTES, SMS_QUARANTINE_ENCODING} from '../devices/sms-quarantine-codec.js';
import {isSmsEventId, isSmsQuarantineReason} from '../devices/sms-quarantine-envelope.js';

const MAX_PAYLOAD = 262144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const columns = `id::text AS id, CASE WHEN isfinite(created_at) AND created_at >= '0001-01-01 00:00:00+00'::timestamptz AND created_at < '10000-01-01 00:00:00+00'::timestamptz THEN to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || '+00' END AS "createdAt",
 CASE WHEN octet_length(device_id)<=1024 THEN device_id END AS "deviceId",
 CASE WHEN octet_length(event_id)<=1024 THEN event_id END AS "eventId",
 CASE WHEN octet_length(reason)<=1024 THEN reason END AS reason,
 CASE WHEN octet_length(encoding)<=64 THEN encoding END AS encoding,
 payload_length AS "payloadLength", octet_length(payload) AS "actualLength"`;

type Input = Parameters<QuarantineRead>[0];
function validateInput(i: Input): void {
 if (typeof i.actorId !== 'string' || i.actorId.length < 1 || i.actorId.length > 256 || !Number.isInteger(i.limit) || i.limit < 1 || i.limit > 51 || !['inventory','export'].includes(i.mode)) throw Error();
 if (i.cursor && (!validPgTimestamp(i.cursor.time) || !UUID.test(i.cursor.id))) throw Error();
 if (i.mode === 'export' ? (!i.id || !UUID.test(i.id) || i.limit !== 1 || i.cursor !== null) : i.id !== undefined) throw Error();
}
function rowFrom(value: Record<string, unknown>): QuarantineRow {
 const {id,createdAt,deviceId,eventId,reason,encoding,payloadLength,actualLength} = value;
 if (typeof id !== 'string' || !UUID.test(id) || !validPgTimestamp(createdAt) ||
  typeof deviceId !== 'string' || !deviceId.length || deviceId.length > 256 ||
  typeof eventId !== 'string' || !eventId.length || eventId.length > 256 ||
  typeof reason !== 'string' || !reason.length || reason.length > 256 || encoding !== 'json-utf16le-v1' ||
  typeof payloadLength !== 'number' || !Number.isSafeInteger(payloadLength) || payloadLength < 0 || actualLength !== payloadLength) throw Error();
 return {id,createdAt,deviceId,eventId,reason,encoding,payloadLength};
}

// Staged only. The caller authenticates at request start; this contract carries no session proof.
export function createSmsQuarantineReader(pool: pg.Pool): QuarantineRead {
 return input => readQuarantine(pool, input);
}

// EXPERIMENTAL and unwired: bearer is hashed locally and never passed to SQL or audit.
// Only this variant revalidates the session; the staged reader above is unchanged.
export function createExperimentalSessionBoundSmsQuarantineReader(pool: pg.Pool) {
 return (input: Input, bearer: string): Promise<QuarantineRow[]> => readQuarantine(pool, input, {bearer});
}

async function readQuarantine(pool: pg.Pool, input: Input, proof?: {bearer: string}): Promise<QuarantineRow[]> {
  try {
   validateInput(input);
   const sessionHash = proof === undefined ? undefined : (() => {
    if (typeof proof.bearer !== 'string' || proof.bearer.length < 1 || proof.bearer.length > 4096) throw Error();
    return tokenHash(proof.bearer);
   })();
   return await transaction(pool, async client => {
    const actor = await client.query(sessionHash ? 'SELECT id FROM admin WHERE id=$1 FOR SHARE' : 'SELECT id FROM admin WHERE id=$1 FOR KEY SHARE',[input.actorId]);
    if (actor.rows.length !== 1) throw Error();
    if (sessionHash) {
     // Match password-change lock order: admin first, session second. SHARE blocks
     // DELETE and all UPDATEs (including expiry changes) until transaction end.
     const session = await client.query('SELECT admin_id FROM admin_session WHERE token_hash=$1 AND admin_id=$2 FOR SHARE',[sessionHash,input.actorId]);
     if (session.rows.length !== 1) throw Error();
     // Linearization point: wall-clock expiry check after acquiring both locks.
     // Expiry may pass during the read; neither validity nor revocation exclusion
     // is guaranteed after transaction commit or delivery to the caller.
     const live = await client.query('SELECT 1 FROM admin_session WHERE token_hash=$1 AND admin_id=$2 AND expires_at>clock_timestamp()',[sessionHash,input.actorId]);
     if (live.rows.length !== 1) throw Error();
    }
    await client.query('INSERT INTO sms_quarantine_access_audit(actor_id,mode,record_id,cursor_time,cursor_id,page_limit) VALUES ($1,$2,$3,$4,$5,$6)',
     [input.actorId,input.mode,input.id ?? null,input.cursor?.time ?? null,input.cursor?.id ?? null,input.limit]);
    const found = input.mode === 'inventory'
     ? await client.query(`SELECT ${columns} FROM sms_quarantine_record WHERE ($1::timestamptz IS NULL OR (created_at,id)<($1::timestamptz,$2::uuid)) ORDER BY created_at DESC,id DESC LIMIT $3`,[input.cursor?.time ?? null,input.cursor?.id ?? null,input.limit])
     : await client.query(`SELECT ${columns} FROM sms_quarantine_record WHERE id=$1::uuid FOR SHARE`,[input.id]);
    if (found.rows.length > input.limit) throw Error();
    const rows = found.rows.map((row: Record<string,unknown>) => rowFrom(row));
    if (input.mode === 'export' && rows.length) {
     const row = rows[0]!;
     if (row.id !== input.id) throw Error();
     if (row.payloadLength <= MAX_PAYLOAD) {
      const bytes = await client.query('SELECT payload FROM sms_quarantine_record WHERE id=$1::uuid AND octet_length(payload)<=$2 AND octet_length(payload)=payload_length',[input.id,MAX_PAYLOAD]);
      if (bytes.rows.length !== 1 || !Buffer.isBuffer(bytes.rows[0].payload) || bytes.rows[0].payload.length !== row.payloadLength) throw Error();
      row.payload = bytes.rows[0].payload;
     }
    }
    return rows;
   });
  } catch { throw new Error('QUARANTINE_UNAVAILABLE'); }
}

const custodyMetadata = `q.id::text AS id, q.device_id AS "deviceId", q.event_id AS "eventId",
  q.device_ts_ms::text AS "deviceTsMs", q.reason, q.encoding, q.payload_length AS "payloadLength",
  to_char(q.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' AS "createdAt",
  ${smsCustodyLinked} AS linked`;
type CustodyRow = QuarantineEvidence & {id: string; deviceId: string; createdAt: string; linked: boolean};

function custodyMetadataFrom(row: CustodyRow): RecoverableQuarantineRow {
  const {id, createdAt, deviceId, eventId, reason, encoding, payloadLength} = row;
  const deviceTs = Number(row.deviceTsMs);
  if (typeof id !== 'string' || id.length !== 36 || !UUID.test(id) || !validPgTimestamp(createdAt) ||
      !isQuarantineDeviceId(deviceId) || !isSmsEventId(eventId) || !isSmsQuarantineReason(reason) ||
      encoding !== SMS_QUARANTINE_ENCODING || !Number.isSafeInteger(payloadLength) || payloadLength < 2 ||
      payloadLength > MAX_SMS_QUARANTINE_BYTES || payloadLength % 2 !== 0 || !Number.isSafeInteger(deviceTs) ||
      deviceTs < 0 || deviceTs > 8_640_000_000_000_000 || String(deviceTs) !== row.deviceTsMs) throw Error();
  return {id,createdAt,deviceId,eventId,deviceTs,reason,encoding,payloadLength,
    state:row.linked === true ? 'retained' : 'needs_attention'};
}

/** Requires an authorized route caller and revalidates its exact bearer in PostgreSQL. */
export function createRecoverableSmsQuarantineReader(pool: pg.Pool): RecoverableQuarantineRead {
  return async (input, bearer) => {
    try {
      validateInput(input);
      if ((input.id && input.id.length !== 36) || (input.cursor && input.cursor.id.length !== 36) ||
          typeof bearer !== 'string' || bearer.length < 1 || bearer.length > 4096) throw Error();
      const sessionHash = tokenHash(bearer);
      return await transaction(pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await client.query('SET LOCAL synchronous_commit = on');
        if (!await canConfirmSmsCustody(client)) throw Error();
        // Password changes lock the admin before revoking its sessions.
        const actor = await client.query('SELECT id FROM admin WHERE id=$1 FOR SHARE',[input.actorId]);
        if (actor.rows.length !== 1) return {status:'denied'};
        const session = await client.query('SELECT admin_id FROM admin_session WHERE token_hash=$1 AND admin_id=$2 FOR SHARE',
          [sessionHash,input.actorId]);
        if (session.rows.length !== 1) return {status:'denied'};
        const live = await client.query('SELECT 1 FROM admin_session WHERE token_hash=$1 AND admin_id=$2 AND expires_at>clock_timestamp()',
          [sessionHash,input.actorId]);
        if (live.rows.length !== 1) return {status:'denied'};

        const found = input.mode === 'inventory'
          ? await client.query<CustodyRow>(`SELECT ${custodyMetadata}
              FROM sms_received_quarantine q ${smsCustodyLinks}
              ${input.cursor ? 'WHERE (q.created_at,q.id)<($2::timestamptz,$3::uuid)' : ''}
              ORDER BY q.created_at DESC,q.id DESC LIMIT $1`,
            input.cursor ? [input.limit,input.cursor.time,input.cursor.id] : [input.limit])
          : await client.query<CustodyRow>(`SELECT ${custodyMetadata}, ${smsCustodyBytes('$2')}
              FROM sms_received_quarantine q ${smsCustodyLinks} WHERE q.id=$1::uuid`,
            [input.id,MAX_SMS_QUARANTINE_BYTES]);
        if (found.rows.length > input.limit) throw Error();
        const rows: RecoverableQuarantineRow[] = [];
        let outcome: 'ok' | 'missing' | 'invalid' = 'ok';
        if (input.mode === 'inventory') {
          rows.push(...found.rows.map(custodyMetadataFrom));
        } else {
          const row = found.rows[0];
          if (!row) outcome = 'missing';
          else if (row.id !== input.id || row.linked !== true || !decodeSmsCustody(row)) outcome = 'invalid';
          else {
            try { rows.push({...custodyMetadataFrom(row), payload:row.payload!}); }
            catch { outcome = 'invalid'; }
          }
        }
        const audit = await client.query(`INSERT INTO sms_received_quarantine_access
          (actor_id,mode,outcome,record_id,cursor_time,cursor_id,row_limit,row_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [input.actorId,input.mode,outcome,input.id??null,input.cursor?.time??null,input.cursor?.id??null,input.limit,found.rows.length]);
        if (audit.rowCount !== 1) throw Error();
        return outcome === 'ok' ? {status:'ok', rows} : {status:outcome};
      });
    } catch { throw new Error('QUARANTINE_UNAVAILABLE'); }
  };
}
