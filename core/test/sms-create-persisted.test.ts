import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {SmsCreateRepository} from '../src/sms/create.js';
import {SmsIdempotencyRepository} from '../src/sms/idempotency.js';

it.each([{origin:'command',direction:'out'},{origin:'admin',direction:'in'}])('rejects an existing key with foreign origin or direction: $origin/$direction',async existing=>{
 const row={id:'m',deviceId:'d',simId:'s',peer:'123',peerKind:'short',body:'hello',parts:1,occurredAt:'42',taskId:'t',state:'queued',errorCode:null,updatedAt:'42',...existing};
 const query=vi.fn(async(sql:string)=>sql.startsWith('SELECT m.id')?{rows:[row]}:sql==='COMMIT'||sql==='ROLLBACK'?{rows:[],command:sql}:{rows:[]});
 const pool={connect:async()=>({query,release(){}})} as unknown as pg.Pool;
 expect(await new SmsCreateRepository(pool).create('key','s','123','hello')).toMatchObject({conflict:true,message:null});
 expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT'))).toBe(false);
});

it('returns persisted values on creation, replay and lookup despite different clocks',async()=>{
 const clock=vi.spyOn(Date,'now').mockReturnValue(1900000000000);
 let message:Record<string,unknown>|undefined;let task:Record<string,unknown>|undefined;let committed=false;
 const query=vi.fn(async(sql:string,params:unknown[]=[])=>{
  if(sql==='ROLLBACK')return {rows:[],rowCount:0,command:'ROLLBACK'};
  if(sql==='BEGIN'||sql.includes('pg_advisory_xact_lock'))return {rows:[],rowCount:0};
  if(sql==='COMMIT'){committed=true;return {rows:[],rowCount:0,command:'COMMIT'};}
  if(sql.startsWith('SELECT m.id')){
   expect(sql).toContain('floor(extract(epoch from m.occurred_at)*1000)');
   expect(sql).toContain('floor(extract(epoch from t.updated_at)*1000)');
   return {rows:message&&task&&params[0]===task.key?[{...message,...task}]:[],rowCount:message&&task?1:0};
  }
  if(sql.startsWith('SELECT device_id FROM sim'))return {rows:[{device_id:'device'}],rowCount:1};
  if(sql.startsWith('SELECT id FROM device')||sql.startsWith('SELECT id FROM sim'))return {rows:[{id:'ok'}],rowCount:1};
  if(sql.startsWith('INSERT INTO sms_message')){message={id:params[0],deviceId:params[1],simId:params[2],direction:'out',peer:params[3],peerKind:params[4],body:params[5],parts:3,occurredAt:'1700000000123'};return {rows:[],rowCount:1};}
  if(sql.startsWith('INSERT INTO sms_task')){task={taskId:params[0],key:params[2],state:'queued',errorCode:null,origin:'admin',updatedAt:'1700000000456'};return {rows:[],rowCount:1};}
  throw new Error(`Unexpected SQL: ${sql}`);
 });
 const release=vi.fn();const pool={query,connect:async()=>({query,release})} as unknown as pg.Pool;
 try{
  const repo=new SmsCreateRepository(pool);
  const initial=await repo.create('key','sim','123','hello');
  expect(committed).toBe(true);
  const replay=await repo.create('key','sim','123','hello');
  const lookup=await new SmsIdempotencyRepository(pool).find('key');
  expect(initial).toMatchObject({deviceId:'device',conflict:false,message:{parts:3,occurredAt:1700000000123,task:{updatedAt:1700000000456}}});
  expect(replay).toEqual(initial);expect(lookup).toEqual(initial?.message);
  expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO sms_message'))).toHaveLength(1);
  expect(release).toHaveBeenCalledTimes(2);
 }finally{clock.mockRestore();}
});
