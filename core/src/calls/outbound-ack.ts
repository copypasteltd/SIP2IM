import type pg from 'pg';
import {ulid} from 'ulid';
import {transaction} from '../db/pool.js';
import {setCallState} from './device-events.js';

/** Persist an ACK only for a previously recorded outbound attempt. This records an intent,
 * never sends a command. The callback marker is quarantined: call IDs do not prove generation identity. */
export async function recordPlatformDialAck(pool:pg.Pool, sessionId:string, deviceId:string, commandId:string, ok:boolean):Promise<'recorded'|'duplicate'|'ignored'|'conflict'> {
 return transaction(pool,async c=>{
  // Match device-event lock order so collision quarantine cannot race ACK correlation.
  await c.query('SELECT id FROM device WHERE id=$1 FOR UPDATE',[deviceId]);
  const sessions=await c.query("SELECT id,kind,state,device_id FROM call_session WHERE id=$1 FOR UPDATE",[sessionId]);
  const session=sessions.rows[0] as {kind:string;state:string;device_id:string}|undefined;
  if(!session || session.kind!=='platform_out' || session.device_id!==deviceId)return 'ignored';
  const attempts=await c.query('SELECT call_id,command_id,ack_state FROM call_outbound_attempt WHERE session_id=$1 AND device_id=$2 FOR UPDATE',[sessionId,deviceId]);
  const attempt=attempts.rows[0] as {call_id:string;command_id:string;ack_state:string}|undefined;
  if(!attempt || attempt.command_id!==commandId)return 'ignored';
  const incoming=ok?'ok':'error';
  // Observation is immutable and separate from operational state, including after restart.
  // The locked session serializes this per-result deduplication.
  await c.query("INSERT INTO call_event(id,session_id,event,payload) SELECT $1,$2,'dial_ack_observed',$3::jsonb WHERE NOT EXISTS (SELECT 1 FROM call_event WHERE session_id=$2 AND event='dial_ack_observed' AND payload->>'result'=$4)",['evt_'+ulid(),sessionId,JSON.stringify({result:incoming,commandId}),incoming]);
  if(attempt.ack_state===incoming)return 'duplicate';
  if(attempt.ack_state!=='pending'){
   if(attempt.ack_state==='unknown')return 'ignored';
   await c.query("UPDATE call_outbound_attempt SET ack_state='unknown',callback_intent='unknown',updated_at=now() WHERE session_id=$1",[sessionId]);
   await c.query("INSERT INTO call_event(id,session_id,event,payload) VALUES($1,$2,'dial_ack_conflict',$3)",['evt_'+ulid(),sessionId,JSON.stringify({previous:attempt.ack_state,received:incoming})]);
   if(session.state!=='ended' && session.state!=='unknown')await setCallState(c,sessionId,session.state as import('./coordinator.js').CallState,'unknown','conflicting_dial_ack','unknown');
   return 'conflict';
  }
  if(session.state!=='cell_dialing')return 'ignored';
  const quarantine=await c.query('SELECT 1 FROM call_identity_quarantine WHERE device_id=$1 AND call_id=$2',[deviceId,attempt.call_id]);
  if(quarantine.rowCount)return 'ignored';
  const legs=await c.query("SELECT state FROM call_leg WHERE session_id=$1 AND type='cellular' AND ref_id=$2 FOR UPDATE",[sessionId,attempt.call_id]);
  if(legs.rowCount!==1)return 'ignored';
  const leg=legs.rows[0] as {state:string};
  if(!ok){
   await c.query("UPDATE call_outbound_attempt SET ack_state='error',callback_intent='none',updated_at=now() WHERE session_id=$1",[sessionId]);
   await setCallState(c,sessionId,'cell_dialing',leg.state==='active'?'unknown':'ending',leg.state==='active'?'active_with_dial_ack_error':'dial_ack_error',leg.state==='active'?'unknown':null);
   return 'recorded';
  }
  if(leg.state==='disconnected')return 'ignored';
  await c.query("UPDATE call_outbound_attempt SET ack_state='ok',callback_intent='quarantined',updated_at=now() WHERE session_id=$1",[sessionId]);
  await setCallState(c,sessionId,'cell_dialing',leg.state==='active'?'unknown':'platform_dialing',leg.state==='active'?'early_active_unattributed':'dial_ack_ok',leg.state==='active'?'unknown':null);
  return 'recorded';
 });
}
