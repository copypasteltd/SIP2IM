import type pg from 'pg';
import { enqueueSmsTaskInvalidation } from './task-invalidation.js';

/** Caller holds the task lock. Invalidate once after the final projected state. */
export async function replaySmsResults(client:pg.PoolClient,id:string,projectionChanged=false):Promise<void> {
  const apply=async(sql:string,args:unknown[]):Promise<void>=>{
    const updated=await client.query(sql,args);
    projectionChanged ||= updated.rowCount===1;
  };
  const r=await client.query(`SELECT e.payload FROM device_event e JOIN sms_task t ON t.id=e.payload->>'taskId' JOIN sms_message m ON m.id=t.sms_message_id AND m.device_id=e.device_id WHERE t.id=$1 AND e.type='sms.result' ORDER BY e.received_at,e.id`,[id]);
  const rows=r.rows as {payload:{state:string;errorCode:string|null}}[];
  // A negative command ACK conflicts with a result, including CONFLICT on a prior reservation.
  // A durable marker prevents later replays from erasing that uncertainty.
  if(rows.length) {
   await apply(`UPDATE sms_task SET state='unknown',error_code='SMS_RESULT_CONFLICT',updated_at=now() WHERE id=$1 AND state IN ('accepted','unknown','failed','sent','delivered') AND (negative_ack OR local_failure OR (legacy_failure AND $2::boolean)) AND (state<>'unknown' OR error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT')`,[id,rows.some(row=>row.payload.state==='sent'||row.payload.state==='delivered')]);
  }
  // Conflicting modem submission evidence cannot establish an outcome, regardless of arrival order.
  if(rows.some(row=>row.payload.state==='failed') && rows.some(row=>row.payload.state==='sent' || row.payload.state==='delivered')) {
   await apply(`UPDATE sms_task SET state='unknown',error_code='SMS_RESULT_CONFLICT',updated_at=now() WHERE id=$1 AND state IN ('accepted','unknown','sent','delivered','failed') AND (state<>'unknown' OR error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT')`,[id]);
  } else {
    for(const wanted of ['sent','failed','delivered','unknown'])for(const row of rows){
     const p=row.payload;if(p.state!==wanted)continue;
     await apply(`UPDATE sms_task SET state=$2,error_code=$3,updated_at=now() WHERE id=$1 AND error_code IS DISTINCT FROM 'SMS_RESULT_CONFLICT' AND ((state IN ('accepted','unknown') AND $2 IN ('sent','failed')) OR (state='accepted' AND $2='unknown') OR (state='sent' AND $2='delivered'))`,[id,p.state,p.errorCode==='SMS_RESULT_CONFLICT'?null:p.errorCode]);
    }
  }
  if (projectionChanged) await enqueueSmsTaskInvalidation(client, id);
}
