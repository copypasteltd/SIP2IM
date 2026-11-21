import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';

describe('incoming SMS SIM attribution',()=>{
 it.each([
  ['a message predating a swap',1000,3000,0],
  ['a delayed message after a swap',1500,5000,0],
  ['a message at an observation boundary',2000,2000,0],
  ['a future PDU clock',9000,3000,0],
  ['an old PDU clock',1,3000,0],
  ['an unknown slot',1500,3000,null],
 ] as const)('preserves %s without guessing a SIM',async(_name,receivedAt,ts,slot)=>{
  const query=vi.fn(async(sql:string,_params?:unknown[])=>{
   if(sql==='COMMIT'||sql==='ROLLBACK'||sql==='SAVEPOINT sms_projection')return {rowCount:0,rows:[],command:sql.split(' ')[0]};
   if(sql.startsWith('SELECT NOT pg_is_in_recovery()'))return {rowCount:1,rows:[{ready:true}]};
   if(sql.startsWith('SELECT id FROM device'))return {rowCount:1,rows:[{id:'device'}]};
   if(sql.startsWith('INSERT INTO device_event'))return {rowCount:1,rows:[{id:'event'}]};
   if(sql.includes('FROM sim'))return {rowCount:2,rows:[{id:'old'},{id:'new'}]};
   return {rowCount:1,rows:[]};
  });
  const pool={connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool;
  const id='evt_00000000000000000000000001';
  const payload={slot,subId:7,from:'peer',fromKind:'unknown',body:'hello',parts:1,receivedAt};
  expect(await new DeviceEvents(pool).handle('device',{v:1,id,type:'sms.received',ts,payload})).toBe('inserted');
  const raw=query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO device_event'));
  expect(raw?.[1]).toEqual([id,'device','sms.received',JSON.stringify(payload),new Date(ts)]);
  const message=query.mock.calls.find(([sql])=>sql.startsWith('INSERT INTO sms_message'));
  expect(message?.[1]?.slice(1)).toEqual([id,'device',null,'peer','unknown','hello',1,new Date(receivedAt)]);
  expect(query.mock.calls.some(([sql])=>sql.includes('FROM sim'))).toBe(false);
  expect(query.mock.calls.some(([sql])=>sql.includes('sms_incoming_admin_outbox'))).toBe(true);
  expect(query.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(true);
 });
});
