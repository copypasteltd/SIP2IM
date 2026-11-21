import type pg from 'pg';
import {ulid} from 'ulid';
import {canConfirmSmsCustody, compareSmsCustodyReplay, retainSmsCustody} from '../db/sms-quarantine-custody.js';
import {enqueueIncomingSms} from '../sms/incoming-outbox.js';
import {isParsedSmsEnvelope, smsQuarantineReasons, type SmsQuarantineReason} from './sms-quarantine-envelope.js';

export type InboundSmsCustodyMode = 'disabled' | 'retain' | 'acknowledge';
export type InboundSmsOutcome = 'inserted' | 'duplicate' | 'rejected' | 'quarantined';
type BlockReason = SmsQuarantineReason | 'event-id-conflict' | 'custody-unavailable';

async function recordBlockedSms(client: pg.PoolClient, deviceId: string, eventId: string, reasons: BlockReason[]): Promise<'rejected'> {
  // One open alert per verified device. Its detail identifies the most recently blocked event.
  const result = await client.query(`INSERT INTO alert(id,type,subject_type,subject_id,severity,state,detail)
    VALUES ($1,'sms_ingestion_blocked','device',$2,'critical','open',$3)
    ON CONFLICT(type,subject_id) WHERE state='open' DO UPDATE SET detail=EXCLUDED.detail,last_at=now()`,
    ['alr_'+ulid(),deviceId,JSON.stringify({eventId,reasons})]);
  if (result.rowCount !== 1) throw new Error('SMS_INGESTION_ALERT_NOT_WRITTEN');
  return 'rejected';
}

/** Match only the projection INSERT's known PostgreSQL B-tree tuple-width diagnostic. */
function isThreadIndexLimit(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const diagnostic = error as {code?: unknown; routine?: unknown};
  return diagnostic.code === '54000' &&
    (diagnostic.routine === '_bt_check_third_page' || diagnostic.routine === 'index_form_tuple' ||
      diagnostic.routine === 'index_form_tuple_context');
}

/** Persist only a protocol-parsed v1 SMS under the caller's active device lock. */
export async function persistInboundSms(client: pg.PoolClient, deviceId: string, event: unknown,
    mode: InboundSmsCustodyMode): Promise<InboundSmsOutcome> {
  if (!isParsedSmsEnvelope(event)) return 'rejected';
  if (!await canConfirmSmsCustody(client)) return recordBlockedSms(client,deviceId,event.id,['custody-unavailable']);
  const custodyEnabled = mode === 'retain' || mode === 'acknowledge';
  const retain = async (reasons: SmsQuarantineReason[]): Promise<InboundSmsOutcome> => {
    if (!custodyEnabled) return recordBlockedSms(client,deviceId,event.id,reasons);
    const custody = await retainSmsCustody(client,deviceId,event,reasons);
    if (custody === 'unavailable') return recordBlockedSms(client,deviceId,event.id,['custody-unavailable']);
    if (custody === 'conflict') return recordBlockedSms(client,deviceId,event.id,['event-id-conflict']);
    return mode === 'acknowledge' ? 'quarantined' : 'rejected';
  };
  const reasons = smsQuarantineReasons(event);
  if (reasons.length) return retain(reasons);

  const payload = JSON.stringify(event.payload);
  const deviceTs = new Date(event.ts);
  // Preserve the device authorization lock when rolling back the normal projection.
  const savepoint = await client.query('SAVEPOINT sms_projection');
  if (savepoint.command !== 'SAVEPOINT') throw new Error('SMS_PROJECTION_SAVEPOINT_NOT_CONFIRMED');
  const stored = await client.query(`INSERT INTO device_event(id,device_id,type,payload,device_ts)
    VALUES ($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING RETURNING id`,
    [event.id,deviceId,event.type,payload,deviceTs]);
  const p = event.payload;
  if (stored.rowCount === 0) {
    // Check both durable records. Use bytewise text equality for the history row.
    const prior = await client.query<{matches: boolean}>(`SELECT (e.device_id=$2 AND e.type=$3
      AND e.payload=$4::jsonb AND e.device_ts=$5 AND m.device_id=$2 AND m.direction='in'
      AND m.peer COLLATE "C"=$6 AND m.peer_kind COLLATE "C"=$7 AND m.body COLLATE "C"=$8
      AND m.parts=$9 AND m.occurred_at=$10) AS matches
      FROM device_event e JOIN sms_message m ON m.event_id=e.id WHERE e.id=$1`,
      [event.id,deviceId,event.type,payload,deviceTs,p.from,p.fromKind,p.body,p.parts,new Date(p.receivedAt)]);
    if (prior.rows.length === 1 && prior.rows[0]?.matches === true) return 'duplicate';
    if (custodyEnabled) {
      const custody = await compareSmsCustodyReplay(client,deviceId,event);
      if (custody === 'exact-replay') return mode === 'acknowledge' ? 'quarantined' : 'rejected';
      if (custody === 'unavailable') return recordBlockedSms(client,deviceId,event.id,['custody-unavailable']);
    }
    return recordBlockedSms(client,deviceId,event.id,['event-id-conflict']);
  }
  if (stored.rowCount !== 1) throw new Error('SMS_EVENT_NOT_WRITTEN');

  // SIM lifecycle observations cannot prove which SIM received this event.
  // An existing history row on a newly claimed event ID must abort the transaction.
  try {
    const message = await client.query(`INSERT INTO sms_message
      (id,event_id,device_id,sim_id,direction,peer,peer_kind,body,parts,occurred_at)
      VALUES ($1,$2,$3,$4,'in',$5,$6,$7,$8,$9)`,
      ['sms_'+ulid(),event.id,deviceId,null,p.from,p.fromKind,p.body,p.parts,new Date(p.receivedAt)]);
    if (message.rowCount !== 1) throw new Error('SMS_HISTORY_NOT_WRITTEN');
  } catch (error) {
    const eventIdConflict = typeof error === 'object' && error !== null &&
      'code' in error && error.code === '23505' && 'constraint' in error && error.constraint === 'sms_message_event_id_key';
    if (!eventIdConflict && !isThreadIndexLimit(error)) throw error;
    const rollback = await client.query('ROLLBACK TO SAVEPOINT sms_projection');
    if (rollback.command !== 'ROLLBACK') throw new Error('SMS_PROJECTION_ROLLBACK_NOT_CONFIRMED');
    return eventIdConflict ? recordBlockedSms(client,deviceId,event.id,['event-id-conflict']) : retain(['postgres-index-limit']);
  }
  await enqueueIncomingSms(client,event.id);
  return 'inserted';
}
