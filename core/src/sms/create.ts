import type pg from 'pg';
import {ulid} from 'ulid';
import {parsePhoneNumberFromString} from 'libphonenumber-js';
import {transaction} from '../db/pool.js';
export function normalizeNumber(raw:string):{number:string;kind:'e164'|'short'}|null {const clean=raw.replace(/[\s()（）\-－]/g,'');if(/^(110|119|120|122|112|999)$/.test(clean))return null;if(/^\d{3,6}$/.test(clean))return {number:clean,kind:'short'};let candidate=clean;if(/^00/.test(candidate))candidate='+'+candidate.slice(2);if(/^1\d{10}$/.test(candidate))candidate='+86'+candidate;else if(/^0\d{9,11}$/.test(candidate))candidate='+86'+candidate.slice(1);else if(/^[2-9]\d{7}$/.test(candidate))candidate='+852'+candidate;if(!candidate.startsWith('+86')&&!candidate.startsWith('+852'))return null;const parsed=parsePhoneNumberFromString(candidate);return parsed?.isValid()&&(parsed.country==='CN'||parsed.country==='HK')?{number:parsed.number,kind:'e164'}:null;}
const selectByKey=`SELECT m.id,m.device_id AS "deviceId",m.sim_id AS "simId",m.direction,m.peer,m.peer_kind AS "peerKind",m.body,m.parts,floor(extract(epoch from m.occurred_at)*1000) AS "occurredAt",t.id AS "taskId",t.state,t.error_code AS "errorCode",t.origin,floor(extract(epoch from t.updated_at)*1000) AS "updatedAt" FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id WHERE t.idempotency_key=$1`;
type CreateResult={deviceId:string;message:unknown;conflict:boolean};
function existingResult(row:Record<string,unknown>,simId:string,to:string,body:string):CreateResult {
 const conflict=row.origin!=='admin'||row.direction!=='out'||row.simId!==simId||row.peer!==to||row.body!==body;
 return {deviceId:String(row.deviceId),message:conflict?null:format(row),conflict};
}
class IdempotencyInsertRace {
 constructor(readonly original:unknown){}
}
function isIdempotencyViolation(error:unknown):boolean {
 return typeof error==='object'&&error!==null&&'code' in error&&error.code==='23505'&&'constraint' in error&&error.constraint==='sms_task_idempotency_key_key';
}
export class SmsCreateRepository {
 constructor(private readonly pool:pg.Pool){}
 async create(key:string,simId:string,to:string,body:string):Promise<CreateResult|null>{
  try {
   return await transaction(this.pool,async c=>{
    await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',[key]);
    const existing=await c.query(selectByKey,[key]);
    let row=existing.rows[0] as Record<string,unknown>|undefined;
    if(row)return existingResult(row,simId,to,body);
    const owner=await c.query('SELECT device_id FROM sim WHERE id=$1',[simId]);
    const deviceId=(owner.rows[0] as {device_id:string}|undefined)?.device_id;
    if(!deviceId)return null;
    const device=await c.query('SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE',[deviceId]);
    if(!device.rowCount)return null;
    const s=await c.query('SELECT id FROM sim WHERE id=$1 AND device_id=$2 AND retired_at IS NULL AND state=$3 FOR UPDATE',[simId,deviceId,'ready']);
    if(!s.rowCount)return null;
    const msg='sms_'+ulid(),task='tsk_'+ulid();
    const kind=to.startsWith('+')?'e164':'short';
    await c.query(`INSERT INTO sms_message(id,device_id,sim_id,direction,peer,peer_kind,body,occurred_at) VALUES($1,$2,$3,'out',$4,$5,$6,now())`,[msg,deviceId,simId,to,kind,body]);
    try {
     await c.query(`INSERT INTO sms_task(id,sms_message_id,origin,state,idempotency_key) VALUES($1,$2,'admin','queued',$3)`,[task,msg,key]);
    } catch(error) {
     if(isIdempotencyViolation(error))throw new IdempotencyInsertRace(error);
     throw error;
    }
    const inserted=await c.query(selectByKey,[key]);
    row=inserted.rows[0] as Record<string,unknown>|undefined;
    if(!row)throw new Error('Inserted SMS task could not be read');
    return {deviceId,message:format(row),conflict:false};
   });
  } catch(error) {
   // The transaction helper only rethrows this marker after ROLLBACK succeeds.
   if(!(error instanceof IdempotencyInsertRace))throw error;
   const existing=await this.pool.query(selectByKey,[key]);
   const row=existing.rows[0] as Record<string,unknown>|undefined;
   if(!row)throw error.original;
   return existingResult(row,simId,to,body);
  }
 }
}
export function format(row:Record<string,unknown>){return {id:row.id,deviceId:row.deviceId,simId:row.simId,direction:'out',peer:row.peer,peerKind:row.peerKind,body:row.body,parts:row.parts,occurredAt:Number(row.occurredAt),task:{id:row.taskId,state:row.state,errorCode:row.errorCode,origin:row.origin,updatedAt:Number(row.updatedAt)}};}
