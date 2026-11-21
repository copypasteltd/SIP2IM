import type pg from 'pg';
import {format} from './create.js';

/** Observes committed state only; an in-flight creator can still commit later. */
export class SmsIdempotencyRepository {
  constructor(private readonly pool:pg.Pool) {}
  async find(key:string):Promise<unknown|null> {
    const result=await this.pool.query(
      `SELECT m.id,m.device_id AS "deviceId",m.sim_id AS "simId",m.peer,m.peer_kind AS "peerKind",m.body,m.parts,floor(extract(epoch from m.occurred_at)*1000) AS "occurredAt",t.id AS "taskId",t.state,t.error_code AS "errorCode",t.origin,floor(extract(epoch from t.updated_at)*1000) AS "updatedAt" FROM sms_task t JOIN sms_message m ON m.id=t.sms_message_id WHERE t.idempotency_key=$1 AND t.origin='admin' AND m.direction='out'`,
      [key]
    );
    const row=result.rows[0] as Record<string,unknown>|undefined;
    return row ? format(row) : null;
  }
}
