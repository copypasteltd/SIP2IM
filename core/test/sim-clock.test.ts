import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';

it.each(['future','delayed'])('records a %s out-of-window snapshot without applying it',async()=>{
 const query=vi.fn(async(sql:string,_params?:unknown[])=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};
  if(sql.startsWith('SELECT id FROM device WHERE id=$1 AND enabled=true'))return {rowCount:1,rows:[{id:'d'}]};
  if(sql.startsWith('INSERT INTO device_event'))return {rowCount:1,rows:[{id:'e'}]};
  if(sql.startsWith('SELECT 1 WHERE'))return {rowCount:1,rows:[{invalid:true}]};
  return {rowCount:0,rows:[]};
 });
 const pool={connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool;
 await new DeviceEvents(pool).handle('d',{id:'e',type:'status.snapshot',ts:1,payload:{sims:[],simsAuthoritative:true,capabilityLevel:'L1',probes:{},permissions:[]}});
 const calls=query.mock.calls.map(([sql])=>sql);
 expect(calls.find(s=>s.startsWith('SELECT 1 WHERE'))).toContain("now()+interval '5 minutes'");
 expect(calls.find(s=>s.startsWith('SELECT 1 WHERE'))).toContain("now()-interval '2 hours'");
 expect(calls.some(s=>s.startsWith('SELECT 1 FROM device_event')||s.startsWith('UPDATE sim')||s.startsWith('UPDATE device SET capability'))).toBe(false);
});
it('keeps exact cutoff inclusive and a previously invalid future event outside the ordering guard',async()=>{
 const now=10_000_000; const received=new Date(now); const future=new Date(now+300001); let savedFuture=false;
 const query=vi.fn(async(sql:string,params?:unknown[])=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};
  if(sql.startsWith('SELECT id FROM device WHERE id=$1 AND enabled=true'))return {rowCount:1,rows:[{id:'d'}]};
  if(sql.startsWith('INSERT INTO device_event')){if(params?.[0]==='future')savedFuture=true;return {rowCount:1,rows:[{id:params?.[0]}]};}
  if(sql.startsWith('SELECT 1 WHERE')){const ts=(params?.[0] as Date).getTime();return {rowCount:0,rows:ts<now-7200000||ts>now+300000?[{}]:[]};}
  if(sql.startsWith('SELECT 1 FROM device_event')){const ts=(params?.[2] as Date).getTime();return {rowCount:0,rows:savedFuture&&future.getTime()>=ts&&future.getTime()<=received.getTime()+300000?[{}]:[]};}
  return {rowCount:0,rows:[]};
 });
 const pool={connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool;
 const service=new DeviceEvents(pool);const payload={sims:[],capabilityLevel:'L1',probes:{},permissions:[]};
 await service.handle('d',{id:'future',type:'status.snapshot',ts:future.getTime(),payload});
 await service.handle('d',{id:'boundary',type:'status.snapshot',ts:now-7200000,payload});
 expect(query.mock.calls.filter(([sql])=>sql.startsWith('UPDATE device SET capability'))).toHaveLength(1);
 const guard=query.mock.calls.find(([sql])=>sql.startsWith('SELECT 1 FROM device_event'))?.[0];
 expect(guard).toContain("device_ts <= received_at+interval '5 minutes'");
});
it('uses observation time for SIM freshness and excludes historically invalid timestamps from ordering',async()=>{
 const query=vi.fn(async(sql:string,_params?:unknown[])=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};
  if(sql.startsWith('SELECT id FROM device WHERE id=$1 AND enabled=true'))return {rowCount:1,rows:[{id:'d'}]};
  if(sql.startsWith('INSERT INTO device_event'))return {rowCount:1,rows:[{id:'e'}]};
  if(sql.startsWith('SELECT id,sub_id'))return {rowCount:1,rows:[{id:'s',sub_id:1,carrier:null,mcc:null,mnc:null,state:'ready'}]};
  return {rowCount:0,rows:[]};
 });
 const pool={connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool;
 await new DeviceEvents(pool).handle('d',{id:'e',type:'status.snapshot',ts:1234,payload:{sims:[{slot:0,subId:1,carrier:null,mcc:null,mnc:null,state:'ready',reportedNumber:null}],capabilityLevel:'L1',probes:{},permissions:[]}});
 const order=query.mock.calls.find(([sql])=>sql.startsWith('SELECT 1 FROM device_event'));
 expect(order?.[0]).toContain("device_ts <= received_at+interval '5 minutes'");
 expect(order?.[0]).toContain("device_ts >= received_at-interval '2 hours'");
 const update=query.mock.calls.find(([sql])=>sql.startsWith('UPDATE sim SET state='));
 expect(update?.[0]).toContain('last_seen_at=LEAST(now(),$8::timestamptz)');
 expect(update?.[1]?.[7]).toEqual(new Date(1234));
});
