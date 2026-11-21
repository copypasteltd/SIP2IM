// Experimental only: no production caller, migration, or ACK integration.
// The caller supplies an already authenticated device identity; this function also
// locks and checks the corresponding active device. Input is parsed, not PDU bytes.
import type pg from 'pg';
import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {parseDeviceMessage} from '@voipgw/protocol';
import {transaction} from './pool.js';
import {canonicalSmsEnvelope, smsQuarantineReasons, type ParsedSmsEnvelope} from '../devices/sms-quarantine-envelope.js';
import {decodeQuarantinePayload, QuarantinePayloadTooLarge} from '../devices/sms-quarantine-codec.js';

function parseSms(value: unknown): ParsedSmsEnvelope {
 const parsed = parseDeviceMessage(value, 'event');
 if (parsed.type !== 'sms.received') throw Error();
 return parsed as ParsedSmsEnvelope;
}

/** Result is an experimental database observation, NOT an ACK authorization. */
export async function experimentalQuarantineSms(pool: pg.Pool, authenticatedDeviceId: string, input: unknown): Promise<'inserted'|'duplicate'|'rejected'> {
 try {
  const event = parseSms(input);
  let bytes: Buffer;
  try { bytes = canonicalSmsEnvelope(event); }
  catch (error) {
   if (error instanceof QuarantinePayloadTooLarge) return 'rejected';
   throw error;
  }
  const reasons = smsQuarantineReasons(event);
  // The current prototype reader limits exports to 256 KiB. Wire-frame size is
  // a separate ingress concern and cannot be reconstructed from parsed input.
  if (!reasons.length || bytes.length > 262144 || typeof authenticatedDeviceId !== 'string' || !authenticatedDeviceId) return 'rejected';
  return await transaction(pool, async client => {
   // Explicit isolation: the post-conflict SELECT must receive a fresh snapshot.
   await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
   const authorized = await client.query('SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE',[authenticatedDeviceId]);
   if (authorized.rows.length !== 1) return 'rejected';
   const inserted = await client.query("INSERT INTO device_event(id,device_id,type,payload,device_ts,custody_kind) VALUES ($1,$2,$3,'{}'::jsonb,$4,'sms_quarantine') ON CONFLICT(id) DO NOTHING RETURNING id",[event.id,authenticatedDeviceId,event.type,new Date(event.ts)]);
   if (inserted.rows.length === 1) {
    await client.query("INSERT INTO sms_quarantine_record(id,event_id,device_id,reason,encoding,payload,payload_length) VALUES ($1,$2,$3,$4,'json-utf16le-v1',$5,$6)",[randomUUID(),event.id,authenticatedDeviceId,reasons.join(','),bytes,bytes.length]);
    await client.query('INSERT INTO sms_quarantine_alert(event_id) VALUES ($1)',[event.id]);
    return 'inserted';
   }
   const prior = await client.query("SELECT device_id=$2 AND type=$3 AND device_ts=$4 AS matches, custody_kind, payload FROM device_event WHERE id=$1 FOR SHARE",[event.id,authenticatedDeviceId,event.type,new Date(event.ts)]);
   if (prior.rows.length !== 1 || prior.rows[0].matches !== true) return 'rejected';
   const row = prior.rows[0];
   let previous: ParsedSmsEnvelope;
   if (row.custody_kind === 'normal') {
    previous = parseSms({v:1,type:event.type,id:event.id,ts:event.ts,payload:row.payload});
    // Protocol parsing strips unknown fields; a legacy JSONB row containing any
    // such fields is not an exact match for the parsed candidate.
    if (!isDeepStrictEqual(row.payload, previous.payload)) return 'rejected';
   } else if (row.custody_kind === 'sms_quarantine') {
    const child = await client.query("SELECT q.device_id,q.encoding,q.reason,q.payload,q.payload_length FROM sms_quarantine_record q WHERE q.event_id=$1 AND octet_length(q.payload)<=262144 FOR SHARE",[event.id]);
    if (child.rows.length !== 1) return 'rejected';
    const q = child.rows[0];
    if (q.device_id !== authenticatedDeviceId || q.encoding !== 'json-utf16le-v1' || !Buffer.isBuffer(q.payload) || q.payload.length !== q.payload_length) return 'rejected';
    const alert = await client.query('SELECT event_id FROM sms_quarantine_alert WHERE event_id=$1 FOR SHARE',[event.id]);
    if (alert.rows.length !== 1) return 'rejected';
    previous = parseSms(decodeQuarantinePayload(q.payload));
    if (q.reason !== smsQuarantineReasons(previous).join(',') || !canonicalSmsEnvelope(previous).equals(q.payload)) return 'rejected';
   } else return 'rejected';
   return canonicalSmsEnvelope(previous).equals(bytes) ? 'duplicate' : 'rejected';
  });
 } catch {
  // Never leak payload, driver errors, or uncertain commit details to logs/callers.
  throw new Error('EXPERIMENTAL_QUARANTINE_UNAVAILABLE');
 }
}
