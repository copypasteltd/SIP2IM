import type pg from 'pg';
import { transaction } from '../db/pool.js';
import type {CallState} from './coordinator.js';
export class CallRepository { constructor(private readonly pool:pg.Pool) {} async changeState(sessionId:string,from:CallState,to:CallState,eventId:string,reason:string):Promise<boolean> { return transaction(this.pool,async c=>{ const result=await c.query(`UPDATE call_session SET state=$3,updated_at=now(),ended_at=CASE WHEN $3='ended' THEN now() ELSE ended_at END WHERE id=$1 AND state=$2`,[sessionId,from,to]); if(result.rowCount!==1) return false; await c.query('INSERT INTO call_event(id,session_id,event,payload) VALUES($1,$2,$3,$4)',[eventId,sessionId,'state:'+to,JSON.stringify({reason})]); return true; }); } }
