import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {SmsCreateRepository} from '../src/sms/create.js';

const winner={id:'winner',deviceId:'device',simId:'sim',direction:'out',peer:'123',peerKind:'short',body:'hello',parts:1,occurredAt:'42',taskId:'task',state:'queued',errorCode:null,origin:'admin',updatedAt:'43'};
const unique=()=>Object.assign(new Error('duplicate key'),{code:'23505',constraint:'sms_task_idempotency_key_key'});
function fake(options:{row?:Record<string,unknown>|null; insertError?:unknown; rollbackError?:unknown; readError?:unknown; commitError?:unknown; messageError?:unknown}={}){
 const events:string[]=[];let staged=false;let persisted=false;
 const query=vi.fn(async(sql:string)=>{
  if(sql==='BEGIN'){events.push('begin');return {rows:[]};}
  if(sql==='ROLLBACK'){events.push('rollback');if(options.rollbackError)throw options.rollbackError;staged=false;return {rows:[],command:'ROLLBACK'};}
  if(sql==='COMMIT'){events.push('commit');if(options.commitError)throw options.commitError;persisted=staged;return {rows:[],command:'COMMIT'};}
  if(sql.includes('pg_advisory'))return {rows:[]};
  if(sql.startsWith('SELECT m.id'))return {rows:staged?[winner]:[]};
  if(sql.startsWith('SELECT device_id'))return {rows:[{device_id:'device'}]};
  if(sql.startsWith('SELECT id FROM'))return {rows:[{id:'ok'}],rowCount:1};
  if(sql.startsWith('INSERT INTO sms_message')){if(options.messageError)throw options.messageError;staged=true;events.push('message');return {rows:[]};}
  if(sql.startsWith('INSERT INTO sms_task')){events.push('task');if(options.insertError)throw options.insertError;return {rows:[]};}
  throw Error(sql);
 });
 const release=vi.fn(()=>events.push('release'));
 const read=vi.fn(async(sql:string,params:unknown[])=>{events.push('read');expect(sql).toContain('WHERE t.idempotency_key=$1');expect(params).toEqual(['key']);expect(staged).toBe(false);if(options.readError)throw options.readError;return {rows:options.row===null?[]:[options.row??winner]};});
 const pool={connect:async()=>({query,release}),query:read} as unknown as pg.Pool;
 return {repo:new SmsCreateRepository(pool),events,read,query,release,get persisted(){return persisted;}};
}
it('rolls back the losing message before reading the committed winner',async()=>{
 const f=fake({insertError:unique()});
 expect(await f.repo.create('key','sim','123','hello')).toEqual({deviceId:'device',conflict:false,message:{id:'winner',deviceId:'device',simId:'sim',direction:'out',peer:'123',peerKind:'short',body:'hello',parts:1,occurredAt:42,task:{id:'task',state:'queued',errorCode:null,origin:'admin',updatedAt:43}}});
 expect(f.events).toEqual(['begin','message','task','rollback','release','read']);expect(f.persisted).toBe(false);
});
it.each([{body:'other'},{simId:'other'},{peer:'456'},{origin:'command'},{direction:'in'}])('returns conflict for a different winning request %o',async patch=>{
 const f=fake({insertError:unique(),row:{...winner,...patch}});
 expect(await f.repo.create('key','sim','123','hello')).toEqual({deviceId:'device',message:null,conflict:true});
 expect(f.events).toEqual(['begin','message','task','rollback','release','read']);
});
it.each([{code:'23505',constraint:'sms_task_pkey'},{code:'23505'},{code:'40001',constraint:'sms_task_idempotency_key_key'}])('propagates unrelated task error %o',async fields=>{
 const error=Object.assign(new Error('db'),fields);const f=fake({insertError:error});
 await expect(f.repo.create('key','sim','123','hello')).rejects.toBe(error);expect(f.read).not.toHaveBeenCalled();expect(f.events).toContain('rollback');
});
it('does not recover the same constraint error from the message insert or commit',async()=>{
 for(const stage of ['messageError','commitError'] as const){const error=unique();const f=fake({[stage]:error});const caught=await f.repo.create('key','sim','123','hello').catch(e=>e);if(stage==='commitError'){expect(caught.cause).toBe(error);expect(caught.message).toContain('uncertain');}else expect(caught).toBe(error);expect(f.read).not.toHaveBeenCalled();}
});
it('does not read after rollback failure',async()=>{
 const original=unique();const failure=new Error('rollback failed');const f=fake({insertError:original,rollbackError:failure});
 const caught=await f.repo.create('key','sim','123','hello').catch(error=>error);
 expect(caught).toBeInstanceOf(AggregateError);expect(caught.errors[0].original).toBe(original);expect(caught.errors[1]).toBe(failure);
 expect(f.release).toHaveBeenCalledWith(true);expect(f.read).not.toHaveBeenCalled();
});
it('propagates failed recovery reads and the original error when the winner is absent',async()=>{
 const failure=new Error('read failed');const f=fake({insertError:unique(),readError:failure});
 await expect(f.repo.create('key','sim','123','hello')).rejects.toBe(failure);
 const original=unique();const missing=fake({insertError:original,row:null});
 await expect(missing.repo.create('key','sim','123','hello')).rejects.toBe(original);
});
