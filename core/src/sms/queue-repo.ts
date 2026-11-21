import type pg from 'pg';
import {transaction} from '../db/pool.js';
import {replaySmsResults} from './results.js';
import type {QueuedSms} from './dispatch.js';
export interface DispatchRecord extends QueuedSms {slot:number;subId:number|null;to:string;body:string}
export const SMS_QUEUE_PER_SIM = 8;
export const SMS_QUEUED_DEVICE_PAGE = 32;

export interface QueuedDevicePage {
  ids: string[];
  /** Exclusive cursor for the next page, or null to wrap on the next pass. */
  nextAfter: string | null;
}

export class SmsQueueRepository {
 constructor(private readonly pool:pg.Pool){}
 async queued(deviceId:string):Promise<DispatchRecord[]>{
  // A global oldest-N limit lets a blocked SIM hide every other SIM. Fetch a
  // small FIFO page plus lookahead for each active SIM instead.
  const r=await this.pool.query<DispatchRecord>(
   `SELECT t.id,s.id AS "simId",s.device_id AS "deviceId",extract(epoch from t.created_at)*1000 AS "createdAt",
      t.created_at<=now()-interval '24 hours' AS expired,s.slot,s.sub_id AS "subId",t.peer AS "to",t.body
      FROM sim s
      JOIN LATERAL (
       SELECT q.id,q.created_at,m.peer,m.body FROM sms_message m JOIN sms_task q ON q.sms_message_id=m.id
        WHERE m.device_id=s.device_id AND m.sim_id=s.id AND m.direction='out' AND q.state='queued'
        ORDER BY q.created_at,q.id LIMIT $2
      ) t ON true
      WHERE s.device_id=$1 AND s.retired_at IS NULL
      ORDER BY t.created_at,t.id`, [deviceId,SMS_QUEUE_PER_SIM+1],
  );
  const pages=new Map<string,{size:number;last:DispatchRecord}>();
  const tasks:DispatchRecord[]=[];
  for(const row of r.rows){
   const page=pages.get(row.simId);
   if(page?.size===SMS_QUEUE_PER_SIM){ page.last.moreForSim=true; continue; }
   const task={...row,createdAt:Number(row.createdAt)};
   tasks.push(task);
   pages.set(row.simId,{size:(page?.size??0)+1,last:task});
  }
  return tasks;
 }
 async simState(id:string,deviceId:string):Promise<'ready'|'unknown'|'unavailable'>{const r=await this.pool.query("SELECT CASE WHEN last_seen_at < now()-interval '2 hours' THEN 'unknown' ELSE state END AS state FROM sim WHERE id=$1 AND device_id=$2 AND retired_at IS NULL",[id,deviceId]);const state=(r.rows[0] as {state:string}|undefined)?.state;return state==='ready'?'ready':state==='absent'||state==='locked'||!state?'unavailable':'unknown';} async canCommand(id:string):Promise<boolean>{const r=await this.pool.query('SELECT 1 FROM device WHERE id=$1 AND online=true AND enabled=true AND paused=false AND revoked_at IS NULL',[id]);return r.rowCount===1;} async failRetired():Promise<number>{return this.failQueued('retired');} async expire():Promise<number>{return this.failQueued('expired');}
 private async failQueued(reason:'retired'|'expired'):Promise<number>{return transaction(this.pool,async client=>{
  const eligible=reason==='retired' ? "EXISTS (SELECT 1 FROM sms_message m JOIN sim s ON s.id=m.sim_id WHERE m.id=t.sms_message_id AND s.retired_at IS NOT NULL)" : "t.created_at<=now()-interval '24 hours'";
  const rows=await client.query<{id:string}>(`SELECT t.id FROM sms_task t WHERE t.state='queued' AND ${eligible} ORDER BY t.created_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 100`);
  let changed=0;
  for(const row of rows.rows){
   const updated=await client.query("UPDATE sms_task SET state='failed',error_code=$2,local_failure=true,updated_at=now() WHERE id=$1 AND state='queued' RETURNING id",[row.id,reason==='retired'?'SIM_NOT_READY':'DEVICE_OFFLINE']);
   if(updated.rowCount===1){await replaySmsResults(client,row.id,true);changed++;}
  }
  return changed;
 });}

 /** A positive command ACK reserves work on the phone. If its final result
  * never arrives, retire only the projection, leaving command and event
  * evidence intact. A matching late result still reconciles normally. */
 async settleUnconfirmed(): Promise<number> {
  return transaction(this.pool, async client => {
   const tasks = await client.query<{ id: string }>(
    `SELECT t.id FROM sms_task t
      WHERE t.state='accepted' AND t.updated_at<=clock_timestamp()-interval '24 hours'
      ORDER BY t.updated_at,t.id FOR UPDATE OF t SKIP LOCKED LIMIT 100`,
   );
   let changed = 0;
   for (const { id } of tasks.rows) {
    const update = await client.query(
     `UPDATE sms_task SET state='unknown',error_code=NULL,updated_at=clock_timestamp()
       WHERE id=$1 AND state='accepted' AND updated_at<=clock_timestamp()-interval '24 hours'`, [id],
    );
    if (update.rowCount !== 1) continue;
    await replaySmsResults(client, id, true);
    changed++;
   }
   return changed;
  });
 }

 async queuedDevices(after: string | null): Promise<QueuedDevicePage> {
  // Compare the key, not a joined cursor row: the previous device may no
  // longer exist or qualify. Keep lookahead out of the dispatched page.
  const limit = SMS_QUEUED_DEVICE_PAGE + 1;
  const r = await this.pool.query<{deviceId: string}>(
   `SELECT d.id AS "deviceId" FROM device d
    WHERE d.online AND d.enabled AND NOT d.paused AND d.revoked_at IS NULL
      ${after === null ? '' : 'AND d.id > $2'} AND EXISTS (
        SELECT 1 FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id JOIN sim s ON s.id=m.sim_id
        WHERE m.device_id=d.id AND m.direction='out' AND t.state='queued' AND s.device_id=d.id AND s.retired_at IS NULL
      ) ORDER BY d.id LIMIT $1`,
   after === null ? [limit] : [limit, after],
  );
  const ids = r.rows.slice(0, SMS_QUEUED_DEVICE_PAGE).map(row => row.deviceId);
  return { ids, nextAfter: r.rows.length > SMS_QUEUED_DEVICE_PAGE ? ids.at(-1)! : null };
 }
 async rate():Promise<number|null>{
  const r=await this.pool.query<{value:unknown}>("SELECT value FROM setting WHERE key='sms_rate_per_min'");
  const value=r.rows[0]?.value;
  if (value===null || (typeof value==='number' && Number.isInteger(value) && value>=1)) return value;
  throw new Error('Persisted SMS rate is missing or invalid');
 }
}
