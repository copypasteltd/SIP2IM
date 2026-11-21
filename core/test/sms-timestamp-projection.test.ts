import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {timestamp} from '@voipgw/protocol';
import {SmsCreateRepository} from '../src/sms/create.js';
import {SmsIdempotencyRepository} from '../src/sms/idempotency.js';
import {SmsHistory} from '../src/sms/history.js';
import {SmsReadRepository} from '../src/sms/read-repo.js';
import {IncomingSmsOutbox} from '../src/sms/incoming-outbox.js';

// Simulate PG's numeric scalar string and json_build_object number after checking its SQL.
const projected=(sql:string,column:string,value:number)=>{
  expect(sql).toContain(`floor(extract(epoch from ${column})*1000)`);
  return Math.floor(value);
};
const message={id:'m',deviceId:'d',simId:'s',direction:'out',peer:'123',peerKind:'short',body:'hi',parts:1,taskId:'t',state:'queued',errorCode:null,origin:'admin'};
const time='2026-01-01 00:00:00.123456+00';
it('projects replay and idempotency message and task timestamps to integer milliseconds',async()=>{
 const query=vi.fn(async(sql:string)=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],command:sql};
  if(!sql.startsWith('SELECT m.id')) return {rows:[]};
  return {rows:[{...message,occurredAt:String(projected(sql,'m.occurred_at',1000.456)),updatedAt:String(projected(sql,'t.updated_at',1001.999))}]};
 });
 const client={query,release:vi.fn()}, pool={query,connect:async()=>client} as unknown as pg.Pool;
 const result=await new SmsCreateRepository(pool).create('key','s','123','hi');
 expect(result?.message).toMatchObject({occurredAt:1000,task:{updatedAt:1001}});
 const formatted=result!.message as {occurredAt:number;task:{updatedAt:number}};
 expect(timestamp.safeParse(formatted.occurredAt).success).toBe(true);expect(timestamp.safeParse(formatted.task.updatedAt).success).toBe(true);
 expect(timestamp.safeParse(1000.456).success).toBe(false);
 expect(await new SmsIdempotencyRepository(pool).find('key')).toMatchObject({occurredAt:1000,task:{updatedAt:1001}});
});
it('keeps message and thread cursor microseconds independent of projected timestamps',async()=>{
 const query=vi.fn(async(sql:string,_params:unknown[])=>{
  expect(sql).toContain("AT TIME ZONE 'UTC'");
  expect(sql).toContain('YYYY-MM-DD HH24:MI:SS.US');
  if(sql.includes('WITH threads')) return {rows:[{deviceId:'d',simId:'s',peer:'123',cursorTime:time,lastAt:String(projected(sql,'occurred_at',1000.456))},{deviceId:'d',simId:'s',peer:'x',cursorTime:time,lastAt:'999'}]};
  return {rows:[{id:'m',cursorTime:time,occurredAt:String(projected(sql,'m.occurred_at',1000.456)),task:{updatedAt:projected(sql,'t.updated_at',1001.999)}},{id:'n',cursorTime:time,occurredAt:'999',task:null}]};
 });
 const history=new SmsHistory({query} as unknown as pg.Pool);
 const page=await history.list({limit:1});expect(page.data[0]).toMatchObject({occurredAt:1000,task:{updatedAt:1001}});
 expect(JSON.parse(Buffer.from(page.nextCursor!,'base64url').toString())).toEqual({time,id:'m'});
 await history.list({limit:1,cursor:page.nextCursor!});expect(query.mock.calls[1]![1][5]).toBe(time);
 const threads=await history.threads(undefined,1);expect(threads.data[0]).toMatchObject({lastAt:1000});
 expect(JSON.parse(Buffer.from(threads.nextCursor!,'base64url').toString()).time).toBe(time);
 await history.threads(undefined,1,threads.nextCursor!);expect(query.mock.calls[3]![1][5]).toBe(time);
});
it('projects task and incoming event reads',async()=>{
 const query=vi.fn(async(sql:string)=>sql.includes('json_build_object')?{rows:[{smsMessageId:'m',task:{updatedAt:projected(sql,'t.updated_at',1001.999)}}]}:{rows:[{id:'m',occurredAt:String(projected(sql,'m.occurred_at',1000.456))}]});
 const repo=new SmsReadRepository({query} as unknown as pg.Pool);
 expect(await repo.task('t')).toMatchObject({task:{updatedAt:1001}});
 expect(await repo.byEvent('evt')).toMatchObject({occurredAt:1000,task:null});
});
it('projects incoming outbox broadcast timestamps',async()=>{
 let pending=true;const query=vi.fn(async(sql:string)=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],command:sql};
  if(sql.includes('FOR UPDATE'))return {rows:pending?[{eventId:'e',id:'m',occurredAt:String(projected(sql,'m.occurred_at',1000.456))}]:[]};
  if(sql.startsWith('DELETE'))pending=false;
  return {rows:[]};
 });
 const publish=vi.fn(async()=>{}),pool={connect:async()=>({query,release(){}})} as unknown as pg.Pool;
 await new IncomingSmsOutbox(pool,publish).flush();
 expect(publish).toHaveBeenCalledWith('sms.new',expect.objectContaining({occurredAt:1000,task:null}));
});

it('rejects invalid calendar cursors and accepts UTC ISO and PostgreSQL offsets',async()=>{
 const query=vi.fn(async()=>({rows:[]}));const history=new SmsHistory({query} as unknown as pg.Pool);
 const enc=(v:unknown)=>Buffer.from(JSON.stringify(v)).toString('base64url');
 for(const time of ['2026-02-30T12:00:00.123456Z','2026-13-01 00:00:00+00']){
  await expect(history.list({limit:1,cursor:enc({time,id:'m'})})).rejects.toThrow('BAD_CURSOR');
  await expect(history.threads(undefined,1,enc({time,deviceId:'d',simId:null,peer:'p'}))).rejects.toThrow('BAD_CURSOR');
 }
 expect(query).not.toHaveBeenCalled();
 for(const time of ['2026-02-28T12:00:00.123456Z','2026-02-28 12:00:00.123456+08:00']){
  await history.list({limit:1,cursor:enc({time,id:'m'})});
  await history.threads(undefined,1,enc({time,deviceId:'d',simId:null,peer:'p'}));
 }
 expect(query).toHaveBeenCalledTimes(4);
});
it('treats inclusive to as the entire millisecond without overflowing Date',async()=>{
 const query=vi.fn(async(_sql:string,_values:unknown[])=>({rows:[]}));const history=new SmsHistory({query} as unknown as pg.Pool);
 await history.list({limit:1,to:8640000000000000,toExclusive:1001});
 const [sql,values]=query.mock.calls[0]!;
 expect(sql).toContain("m.occurred_at < $5::timestamptz + interval '1 millisecond'");
 expect(sql).toContain('m.occurred_at < $9');
 expect((values[4] as Date).getTime()).toBe(8640000000000000);
 expect((values[8] as Date).getTime()).toBe(1001);
});
