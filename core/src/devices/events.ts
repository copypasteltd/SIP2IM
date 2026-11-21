import type pg from 'pg';
import {ulid} from 'ulid';
import {transaction} from '../db/pool.js';
import {replaySmsResults, SMS_CALLBACK_CONFLICT, SMS_RESULT_CONFLICT} from '../sms/results.js';
import {persistInboundSms, type InboundSmsCustodyMode, type InboundSmsOutcome} from './inbound-sms.js';
import {confirmedSimChange} from './sim-identity.js';
import {normalizeNumber} from '../sms/create.js';
import {persistCallDeviceEvent} from '../calls/device-events.js';
import type {CallEventContext} from '../calls/generation.js';
type Sim={slot:number;subId:number|null;carrier:string|null;mcc:string|null;mnc:string|null;state:string;reportedNumber:string|null};
type Event={v?:1;id:string;type:string;ts:number;payload:unknown};
// Probes retain their original time, including delayed observations; ties keep the first result.
// Future-at-receipt legacy rows are untrusted and may be replaced by valid evidence.
const validTimestamp=(value:number)=>Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000;
export class DeviceEvents {
 private readonly smsCustody: InboundSmsCustodyMode;
 constructor(private readonly pool:pg.Pool, options: {smsCustody?: InboundSmsCustodyMode} = {}) {
  this.smsCustody = options.smsCustody ?? 'disabled';
 }
 async handle(deviceId:string,event:Event,callContext?:CallEventContext):Promise<InboundSmsOutcome>{
  if(!validTimestamp(event.ts)||!['status.snapshot','sms.received','sms.result','call.incoming','call.state'].includes(event.type))return 'rejected';
  return transaction(this.pool,async c=>{
   if (event.type === 'sms.received' || event.type === 'sms.result') {
    await c.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await c.query('SET LOCAL synchronous_commit = on');
   }
 const authorized=await c.query('SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE',[deviceId]);
 if(!authorized.rowCount)return 'rejected';
 if(event.type==='sms.received')return persistInboundSms(c,deviceId,event,this.smsCustody);
 let smsResultTaskId: string | undefined;
 if (event.type === 'sms.result') {
  const result = event.payload as {taskId:string;state:string;errorCode?:string|null};
  if (result.errorCode === SMS_RESULT_CONFLICT || (result.errorCode === SMS_CALLBACK_CONFLICT && result.state !== 'unknown')) return 'rejected';
  const owned = await c.query(
   "SELECT t.id FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id WHERE t.id=$1 AND m.device_id=$2 AND m.direction='out' FOR UPDATE OF t",
   [result.taskId, deviceId],
  );
  if (owned.rowCount !== 1) return 'rejected';
  smsResultTaskId = result.taskId;
 }
 const payload = JSON.stringify(event.payload);
 const deviceTs = new Date(event.ts);
 const inserted = await c.query(
  'INSERT INTO device_event(id,device_id,type,payload,device_ts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING id',
  [event.id, deviceId, event.type, payload, deviceTs],
 );
 if (!inserted.rowCount) {
  const prior = await c.query(
   'SELECT device_id=$2 AND type=$3 AND payload=$4::jsonb AND device_ts=$5 AS matches FROM device_event WHERE id=$1',
   [event.id, deviceId, event.type, payload, deviceTs],
  );
  if (prior.rows[0]?.matches !== true) return 'rejected';
 }
 // Reconcile from stored evidence, including after replay of a previously stored result.
 if (smsResultTaskId !== undefined) await replaySmsResults(c, smsResultTaskId);
 if (!inserted.rowCount) return 'duplicate';
 if(event.type==='call.incoming'||event.type==='call.state'){await persistCallDeviceEvent(c,deviceId,event,callContext);
 }else if(event.type==='status.snapshot'){const p=event.payload as {sims:Sim[];simsAuthoritative?:boolean;capabilityLevel:string;probes:Record<string,{result:string;probedAt:number}>;permissions:unknown};for(const [field,value] of Object.entries(p.probes))if(validTimestamp(value.probedAt))await c.query(`INSERT INTO device_status(device_id,field,value,observed_at,ttl_sec) SELECT $1,$2,$3,$4::timestamptz,604800 WHERE $4::timestamptz >= 'epoch'::timestamptz AND $4::timestamptz <= $5::timestamptz AND $4::timestamptz <= now() AND $5::timestamptz <= now()+interval '5 minutes' ON CONFLICT(device_id,field) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,ttl_sec=excluded.ttl_sec,received_at=now() WHERE device_status.observed_at<excluded.observed_at OR device_status.observed_at>device_status.received_at`,[deviceId,'probe.'+field,JSON.stringify(value),new Date(value.probedAt),new Date(event.ts)]);const invalidTime=await c.query("SELECT 1 WHERE $1::timestamptz < now()-interval '2 hours' OR $1::timestamptz > now()+interval '5 minutes'",[new Date(event.ts)]);if(invalidTime.rows.length)return 'inserted';const newer=await c.query("SELECT 1 FROM device_event WHERE device_id=$1 AND type='status.snapshot' AND id<>$2 AND device_ts >= $3 AND device_ts >= received_at-interval '2 hours' AND device_ts <= received_at+interval '5 minutes' LIMIT 1",[deviceId,event.id,new Date(event.ts)]);if(newer.rows.length)return 'inserted';await c.query('UPDATE device SET capability_level=$2,updated_at=now() WHERE id=$1',[deviceId,p.capabilityLevel]);for(const sim of p.sims){const r=await c.query('SELECT id,sub_id,carrier,mcc,mnc,state FROM sim WHERE device_id=$1 AND slot=$2 AND retired_at IS NULL FOR UPDATE',[deviceId,sim.slot]);const old=r.rows[0] as {id:string;sub_id:number|null;carrier:string|null;mcc:string|null;mnc:string|null;state:string}|undefined;const changed=!!old&&confirmedSimChange({subId:old.sub_id,carrier:old.carrier,mcc:old.mcc,mnc:old.mnc,state:old.state},sim);if(changed)await c.query('UPDATE sim SET retired_at=now(),updated_at=now() WHERE id=$1',[old!.id]);const simId=(!old||changed)?'sim_'+ulid():old.id;if(!old||changed)await c.query('INSERT INTO sim(id,device_id,slot,sub_id,carrier,mcc,mnc,state,reported_number,needs_review,last_seen_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,LEAST(now(),$11::timestamptz))',[simId,deviceId,sim.slot,sim.subId,sim.carrier,sim.mcc,sim.mnc,sim.state,sim.reportedNumber,changed,new Date(event.ts)]);else await c.query('UPDATE sim SET state=$2,reported_number=COALESCE($3,reported_number),sub_id=COALESCE($4,sub_id),carrier=COALESCE($5,carrier),mcc=COALESCE($6,mcc),mnc=COALESCE($7,mnc),last_seen_at=LEAST(now(),$8::timestamptz),updated_at=now() WHERE id=$1',[simId,sim.state,sim.reportedNumber,sim.subId,sim.carrier,sim.mcc,sim.mnc,new Date(event.ts)]);const number=sim.reportedNumber?normalizeNumber(sim.reportedNumber):null;if(number)await c.query("INSERT INTO sim_number(sim_id,number,number_kind,source) VALUES($1,$2,$3,'reported') ON CONFLICT(sim_id) DO UPDATE SET number=excluded.number,number_kind=excluded.number_kind,updated_at=now() WHERE sim_number.source='reported'",[simId,number.number,number.kind]);}if(p.simsAuthoritative===true)await c.query("UPDATE sim SET state='unknown',updated_at=now() WHERE device_id=$1 AND retired_at IS NULL AND NOT (slot = ANY($2::int[]))",[deviceId,p.sims.map(sim=>sim.slot)]);await c.query(`INSERT INTO device_status(device_id,field,value,observed_at,ttl_sec) VALUES($1,'permissions',$2,$3,86400) ON CONFLICT(device_id,field) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,ttl_sec=excluded.ttl_sec,received_at=now() WHERE device_status.observed_at<=excluded.observed_at`,[deviceId,JSON.stringify(p.permissions),new Date(event.ts)]);

 }
 return 'inserted';});} }
