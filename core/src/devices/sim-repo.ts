import type pg from 'pg';
import {transaction} from '../db/pool.js';

export class SimRepository {
  constructor(private readonly pool:pg.Pool){}
  async review(id:string):Promise<boolean>{const r=await this.pool.query('UPDATE sim SET needs_review=false,updated_at=now() WHERE id=$1 AND retired_at IS NULL',[id]);return r.rowCount===1;}
  async setNumber(id:string,number:string,kind:'e164'|'short',expectedNumber?:string|null):Promise<unknown|null>{
    return transaction(this.pool,async c=>{
      // Every SIM number writer locks its parent SIM first, including snapshots.
      const r=await c.query('SELECT id,device_id,slot,sub_id,carrier,state,needs_review,last_seen_at FROM sim WHERE id=$1 AND retired_at IS NULL FOR UPDATE',[id]);
      const row=r.rows[0] as {id:string;device_id:string;slot:number;sub_id:number|null;carrier:string|null;state:string;needs_review:boolean;last_seen_at:Date}|undefined;
      if(!row)return null;
      if(expectedNumber!==undefined){
        const current=await c.query('SELECT number FROM sim_number WHERE sim_id=$1 FOR UPDATE',[id]);
        const currentNumber=(current.rows[0] as {number:string}|undefined)?.number??null;
        if(currentNumber!==expectedNumber)return {conflict:true,currentNumber};
      }
      await c.query(`INSERT INTO sim_number(sim_id,number,number_kind,source) VALUES($1,$2,$3,'manual') ON CONFLICT(sim_id) DO UPDATE SET number=excluded.number,number_kind=excluded.number_kind,source='manual',updated_at=now()`,[id,number,kind]);
      return {id:row.id,deviceId:row.device_id,slot:row.slot,subId:row.sub_id,carrier:row.carrier,state:row.state,number,numberKind:kind,numberSource:'manual',needsReview:row.needs_review,lastSeenAt:row.last_seen_at.getTime()};
    });
  }
}
