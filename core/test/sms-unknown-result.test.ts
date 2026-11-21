import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {replaySmsResults} from '../src/sms/results.js';

it('replays unknown and later authoritative callbacks without regressing definitive state',async()=>{
 let state='dispatched';
 const events:{state:string;errorCode:null}[]=[{state:'unknown',errorCode:null}];
 const client={query:vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT e.payload')) return {rows:events.map(payload=>({payload}))};
  if(sql.startsWith('UPDATE sms_task')) {
   const next=args![1] as string;
   if ((state==='accepted' && next==='unknown') || (['accepted','unknown'].includes(state) && ['sent','failed'].includes(next)) || (state==='sent' && next==='delivered')) state=next;
   return {rowCount:1,rows:[]};
  }
  return {rowCount:0,rows:[]};
 })} as unknown as pg.PoolClient;
 await replaySmsResults(client,'task'); expect(state).toBe('dispatched');
 state='accepted'; await replaySmsResults(client,'task'); expect(state).toBe('unknown');
 events.unshift({state:'delivered',errorCode:null},{state:'sent',errorCode:null});
 await replaySmsResults(client,'task'); expect(state).toBe('delivered');
 await replaySmsResults(client,'task'); expect(state).toBe('delivered');
 expect((client.query as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('m.device_id=e.device_id');
});
