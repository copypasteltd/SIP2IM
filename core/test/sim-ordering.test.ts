import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';

it('retains a delayed snapshot as an event without changing current state',async()=>{
 const query=vi.fn(async(sql:string,_params?:unknown[])=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};
  if(sql.startsWith('INSERT INTO device_event'))return {rowCount:1,rows:[{id:'e'}]};
  if(sql.startsWith('SELECT 1 FROM device_event'))return {rowCount:1,rows:[{'?column?':1}]};
  return {rowCount:1,rows:[]};
 });
 const pool={connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool;
 expect(await new DeviceEvents(pool).handle('d',{id:'e',type:'status.snapshot',ts:1,payload:{sims:[],simsAuthoritative:true,capabilityLevel:'L1',probes:{},permissions:[]}})).toBe('inserted');
 const sql=query.mock.calls.map(([s])=>s);
 expect(sql.indexOf('SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE')).toBeLessThan(sql.findIndex(s=>s.startsWith('INSERT INTO device_event')));
 expect(sql.some(s=>s.startsWith('UPDATE sim')||s.startsWith('UPDATE device SET capability'))).toBe(false);
 expect(sql).toContain('COMMIT');
});
