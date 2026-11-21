import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {SmsRepository} from '../src/sms/repo.js';
import {makeDeviceEventProducer} from '../src/devices/event-producer.js';
it.each(['unknown','sent','delivered','failed'])('preserves ambiguity when negative acknowledgement contradicts %s evidence',async(evidence)=>{
 let state='dispatched',errorCode:string|null=null;
 const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};
  if(sql.startsWith('UPDATE sms_task SET state=$3')) {state='failed';errorCode=String(args![3]);return {rowCount:1,rows:[]};}
  if(sql.startsWith('SELECT e.payload')) return {rows:[{payload:{state:evidence,errorCode:null}}]};
  if(sql.includes("error_code='SMS_RESULT_CONFLICT'")) {if(state==='failed'){state='unknown';errorCode='SMS_RESULT_CONFLICT';}return {rowCount:1,rows:[]};}
  if(sql.startsWith('UPDATE sms_task SET state=$2')) {if(errorCode!=='SMS_RESULT_CONFLICT')state=String(args![1]);return {rowCount:1,rows:[]};}
  return {rowCount:0,rows:[]};
 });
 const pool={connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool;
 await new SmsRepository(pool).changeState('task','dispatched','failed','CONFLICT');
 expect(state).toBe('unknown');expect(errorCode).toBe('SMS_RESULT_CONFLICT');
});
it.each([['unknown','failed'],['failed','unknown']])('negative ACK persists conflict with %s then %s result',async(first,second)=>{
 let state='failed',code:string|null='CONFLICT';const rows:string[]=[];
 const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT e.payload'))return {rows:rows.map(value=>({payload:{state:value,errorCode:null}}))};
  if(sql.includes('negative_ack OR local_failure')){if(state==='failed'){state='unknown';code='SMS_RESULT_CONFLICT';}return {rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE sms_task SET state=$2') && code!=='SMS_RESULT_CONFLICT')state=String(args![1]);
  return {rows:[],rowCount:1};
 });
 const {replaySmsResults}=await import('../src/sms/results.js');const client={query} as unknown as pg.PoolClient;
 rows.push(first);await replaySmsResults(client,'task');rows.push(second);await replaySmsResults(client,'task');
 expect(state).toBe('unknown');expect(code).toBe('SMS_RESULT_CONFLICT');
});
it('retries task notification when committed event is retransmitted after publish failure',async()=>{
 let handled=0;const taskUpdated=vi.fn().mockRejectedValueOnce(Error('publish failed')).mockResolvedValueOnce(undefined);
 const producer=makeDeviceEventProducer({handle:async()=>++handled===1?'inserted':'duplicate',readSms:async()=>null,publish:async()=>{},taskUpdated});
 const event={id:'event',type:'sms.result',ts:1,payload:{taskId:'task'}};
 await expect(producer('device',event)).rejects.toThrow('publish failed');
 expect(await producer('device',event)).toBe(true);expect(taskUpdated).toHaveBeenCalledTimes(2);
});
