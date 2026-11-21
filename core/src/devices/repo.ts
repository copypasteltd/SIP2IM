import type pg from 'pg';
import {transaction} from '../db/pool.js';
import {observation,type Observation} from './status.js';

const upsertStatus = `INSERT INTO device_status(device_id,field,value,observed_at,ttl_sec) VALUES ($1,$2,$3,$4,$5) ON CONFLICT(device_id,field) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,ttl_sec=excluded.ttl_sec,received_at=now() WHERE device_status.observed_at <= excluded.observed_at`;

export class DeviceStatusRepository {
  constructor(private readonly pool: pg.Pool) {}
  async put(deviceId:string,field:string,item:Observation<unknown>): Promise<void> {
    await this.pool.query(upsertStatus,[deviceId,field,JSON.stringify(item.value),new Date(item.observedAt),item.ttlSec]);
  }
  async heartbeat(deviceId:string,fields:Record<string,unknown>,observedAt:number):Promise<{accepted:boolean;becameOnline:boolean}> {
    return transaction(this.pool,async client=>{
      const result=await client.query('SELECT enabled,revoked_at,online FROM device WHERE id=$1 FOR UPDATE',[deviceId]);
      const device=result.rows[0] as {enabled:boolean;revoked_at:Date|null;online:boolean}|undefined;
      if(!device || !device.enabled || device.revoked_at!==null) return {accepted:false,becameOnline:false};
      // Sample after the row lock, since transaction now() predates lock waits.
      // Liveness comes from receipt on the authenticated socket. The raw clock
      // is not persisted by the heartbeat schema. Allow -2h/+5min clock skew,
      // but never make a genuinely old observation fresh. Suspect timestamps
      // produce unknown values and force paused; receipt alone cannot clear it.
      const clock=await client.query<{received_at:Date}>('SELECT clock_timestamp() AS received_at');
      const receivedAt=clock.rows[0]!.received_at;
      const delta=observedAt-receivedAt.getTime();
      const suspect=!Number.isFinite(delta) || delta < -7200000 || delta > 300000;
      const effectiveAt=new Date(suspect ? receivedAt.getTime() : Math.min(observedAt,receivedAt.getTime()));
      const stale=suspect || receivedAt.getTime()-effectiveAt.getTime()>90000;
      let pausedUpdated=false;
      for(const [field,value] of Object.entries(fields)) {
        const item=observation(field==='paused' && (stale || value===true) ? true : suspect ? null : value,field==='paused' && (stale || value===true) ? receivedAt.getTime() : effectiveAt.getTime(),'heartbeat');
        // A legacy future-dated row is untrusted and must not block a valid update.
        // A forced pause and unknown values remain authoritative until a newer
        // device timestamp clears them; clock correction can delay availability.
        const updated=await client.query(`INSERT INTO device_status(device_id,field,value,observed_at,ttl_sec,received_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(device_id,field) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,ttl_sec=excluded.ttl_sec,received_at=excluded.received_at WHERE $7::boolean OR device_status.observed_at > device_status.received_at OR device_status.observed_at < excluded.observed_at OR (device_status.observed_at = excluded.observed_at AND device_status.value = excluded.value) RETURNING field`,[deviceId,field,JSON.stringify(item.value),new Date(item.observedAt),item.ttlSec,receivedAt,field==='paused' && (stale || value===true)]);
        if(field==='paused' && updated.rowCount) pausedUpdated=true;
      }
      await client.query('UPDATE device SET online=true,last_seen_at=$4,paused=CASE WHEN $3::boolean THEN $2::boolean ELSE paused END,updated_at=$4 WHERE id=$1',[deviceId,stale ? true : fields.paused??null,stale || pausedUpdated,receivedAt]);
      return {accepted:true,becameOnline:!device.online};
    });
  }
  async markOffline(offlineAfterSec:number): Promise<string[]> {
    const r=await this.pool.query(`UPDATE device SET online=false,updated_at=now() WHERE online=true AND (last_seen_at IS NULL OR last_seen_at < now() - ($1 * interval '1 second')) RETURNING id`,[offlineAfterSec]);
    return (r.rows as {id:string}[]).map(row=>row.id);
  }
}
