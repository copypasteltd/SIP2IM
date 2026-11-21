import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';

it.each([undefined,false,true])('only invalidates omitted SIMs for explicit authority: %s',async authoritative=>{
 const query=vi.fn(async(sql:string,_params?:unknown[])=>sql==='COMMIT'||sql==='ROLLBACK'?{rowCount:0,rows:[],command:sql}:sql.startsWith('INSERT INTO device_event')?{rowCount:1,rows:[{id:'e'}]}:{rowCount:1,rows:[]});
 const pool={connect:async()=>({query,release:()=>{}})} as unknown as pg.Pool;
 await new DeviceEvents(pool).handle('d',{id:'e',type:'status.snapshot',ts:1,payload:{sims:[],simsAuthoritative:authoritative,capabilityLevel:'L1',probes:{},permissions:[]}});
 const invalidate=query.mock.calls.filter(([sql])=>sql.startsWith("UPDATE sim SET state='unknown'"));
 expect(invalidate).toHaveLength(authoritative===true?1:0);
 if(authoritative)expect(invalidate[0]?.[1]).toEqual(['d',[]]);
 expect(query.mock.calls.some(([sql])=>sql.includes('retired_at=now()')||sql.includes('sim_number'))).toBe(false);
});
