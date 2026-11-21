import {expect,it} from 'vitest';
import type pg from 'pg';
import {SimRepository} from '../src/devices/sim-repo.js';

it('serializes competing conditional updates and distinguishes null and exact stored values',async()=>{
 let number:string|null=null;let tail=Promise.resolve();let writes=0;
 const pool={connect:async()=>{let releaseLock:(()=>void)|undefined;return {release(){},async query(sql:string,args?:unknown[]){
  if(sql==='BEGIN')return {command:'BEGIN',rows:[]};
  if(sql==='COMMIT'){releaseLock?.();return {command:'COMMIT',rows:[]};}
  if(sql.startsWith('SELECT id,device_id')){const before=tail;tail=new Promise<void>(resolve=>{releaseLock=resolve});await before;return {rows:[{id:'sim',device_id:'dev',slot:0,sub_id:null,carrier:null,state:'ready',needs_review:false,last_seen_at:new Date(0)}]};}
  if(sql.startsWith('SELECT number'))return {rows:number===null?[]:[{number}]};
  if(sql.startsWith('INSERT INTO sim_number')){number=args![1] as string;writes++;return {rows:[]};}
  throw new Error(sql);
 }};}} as unknown as pg.Pool;
 const repo=new SimRepository(pool);const results=await Promise.all([repo.setNumber('sim','111','short',null),repo.setNumber('sim','222','short',null)]);
 expect(results[0]).toMatchObject({number:'111'});expect(results[1]).toEqual({conflict:true,currentNumber:'111'});expect(writes).toBe(1);
 expect(await repo.setNumber('sim','333','short',' 111 ')).toEqual({conflict:true,currentNumber:'111'});
 expect(await repo.setNumber('sim','444','short')).toMatchObject({number:'444'});
});
