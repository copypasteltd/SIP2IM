import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {replaySmsResults} from '../src/sms/results.js';

it('replays unknown then failed repeatedly without inventing a conflict',async()=>{
 let state='accepted',code:string|null=null;const events:string[]=[];
 const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT e.payload'))return {rows:events.map(value=>({payload:{state:value,errorCode:value==='failed'?'SMS_SEND_FAILED':null}}))};
  if(sql.includes('negative_ack OR local_failure'))return {rowCount:0,rows:[]};
  if(sql.includes("state IN ('accepted','unknown','sent','delivered','failed')"))return {rowCount:0,rows:[]};
  if(sql.startsWith('UPDATE sms_task SET state=$2')){
   const next=String(args![1]);if(code!=='SMS_RESULT_CONFLICT' && ((['accepted','unknown'].includes(state)&&['sent','failed'].includes(next))||(state==='accepted'&&next==='unknown')||(state==='sent'&&next==='delivered'))){state=next;code=args![2] as string|null;}
  }
  return {rowCount:1,rows:[]};
 });
 const client={query} as unknown as pg.PoolClient;
 events.push('unknown');await replaySmsResults(client,'task');expect(state).toBe('unknown');
 events.push('failed');await replaySmsResults(client,'task');expect(state).toBe('failed');expect(code).toBe('SMS_SEND_FAILED');
 events.push('failed');await replaySmsResults(client,'task');await replaySmsResults(client,'task');expect(state).toBe('failed');expect(code).toBe('SMS_SEND_FAILED');
});
it('uses persisted local failure provenance when device evidence arrives',async()=>{
 const calls:string[]=[];const query=vi.fn(async(sql:string)=>{calls.push(sql);return sql.startsWith('SELECT e.payload')?{rows:[{payload:{state:'failed',errorCode:'SMS_SEND_FAILED'}}]}:{rowCount:1,rows:[]};});
 await replaySmsResults({query} as unknown as pg.PoolClient,'task');
 expect(calls[1]).toContain('negative_ack OR local_failure');
});
