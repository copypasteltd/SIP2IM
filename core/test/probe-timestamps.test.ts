import {describe,expect,it} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';

const now=Date.parse('2026-01-10T12:00:00Z');
type Probe={result:string;probedAt:number;detail:null};
type Row={value:Probe;observedAt:number;receivedAt:number};
function setup(initial?:Row){
  let row=initial;const events=new Map<string,string>();const calls:string[]=[];let probeSql='';
  const client={release(){},async query(sql:string,args:unknown[]=[]){
    calls.push(sql);
    if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};
    if(sql.startsWith('SELECT id FROM device WHERE'))return {rowCount:1,rows:[{id:'d'}]};
    if(sql.startsWith('INSERT INTO device_event')){const id=args[0] as string;if(events.has(id))return {rowCount:0,rows:[]};events.set(id,args[3] as string);return {rowCount:1,rows:[{id}]};}
    if(sql.startsWith('SELECT device_id=$2'))return {rowCount:1,rows:[{matches:events.get(args[0] as string)===args[3]}]};
    if(sql.startsWith('SELECT 1 WHERE')){const ts=(args[0] as Date).getTime();return {rowCount:ts<now-7200000||ts>now+300000?1:0,rows:ts<now-7200000||ts>now+300000?[{}]:[]};}
    if(sql.startsWith('INSERT INTO device_status')&&args[1]==='probe.dial'){
      probeSql=sql;const at=(args[3] as Date).getTime(),snapshot=(args[4] as Date).getTime();
      if(at>=0&&at<=snapshot&&at<=now&&snapshot<=now+300000&&(!row||row.observedAt<at||row.observedAt>row.receivedAt))row={value:JSON.parse(args[2] as string),observedAt:at,receivedAt:now};
    }
    return {rowCount:0,rows:[]};
  }};
  const service=new DeviceEvents({connect:async()=>client} as unknown as pg.Pool);
  const send=async(id:string,probe:Probe,ts=now)=>service.handle('d',{id,type:'status.snapshot',ts,payload:{sims:[],capabilityLevel:'L1',probes:{dial:probe},permissions:[]}});
  return {send,events,calls,get row(){return row;},get probeSql(){return probeSql;}};
}
const probe=(result:string,probedAt:number):Probe=>({result,probedAt,detail:null});
describe('probe timestamps',()=>{
  it('keeps future evidence durable without projecting false success or changing a prior result',async()=>{
    const f=setup({value:probe('fail',now-1000),observedAt:now-1000,receivedAt:now-1000});const future=probe('ok',now+86400000);
    expect(await f.send('future',future)).toBe('inserted');expect(JSON.parse(f.events.get('future')!).probes.dial).toEqual(future);expect(f.row?.value.result).toBe('fail');
    expect(await f.send('future',future)).toBe('duplicate');
    expect(f.probeSql).toContain('$4::timestamptz <= $5::timestamptz');expect(f.probeSql).toContain('$4::timestamptz <= now()');
  });
  it('recovers a previously poisoned row with valid older evidence',async()=>{
    const f=setup({value:probe('ok',now+86400000),observedAt:now+86400000,receivedAt:now-1000});const valid=probe('fail',now-3600000);
    expect(await f.send('recovery',valid)).toBe('inserted');expect(f.row?.value).toEqual(valid);expect(f.row?.observedAt).toBe(valid.probedAt);
    expect(f.probeSql).toContain("device_status.observed_at>device_status.received_at");
  });
  it('preserves stale evidence and respects ordering for trustworthy rows',async()=>{
    const f=setup();const stale=probe('ok',now-8*86400000);await f.send('stale',stale);expect(f.row?.observedAt).toBe(stale.probedAt);
    const recent=probe('fail',now-1000);await f.send('recent',recent);await f.send('old',stale);expect(f.row?.value).toEqual(recent);
  });
  it('projects an old snapshot probe at its original time without applying old SIM state',async()=>{
    const f=setup();const old=probe('ok',now-3*3600000);expect(await f.send('old-snapshot',old,old.probedAt)).toBe('inserted');expect(f.row?.observedAt).toBe(old.probedAt);expect(JSON.parse(f.events.get('old-snapshot')!).probes.dial).toEqual(old);expect(f.calls.some(sql=>sql.startsWith('UPDATE sim')||sql.startsWith('UPDATE device SET capability')||sql.includes("'permissions'"))).toBe(false);
  });
  it('keeps an excessively future snapshot durable without projecting even a past probe',async()=>{
    const f=setup();await f.send('future-snapshot',probe('ok',now-1000),now+300001);expect(f.events.has('future-snapshot')).toBe(true);expect(f.row).toBeUndefined();expect(f.calls.some(sql=>sql.startsWith('UPDATE device SET capability'))).toBe(false);expect(f.probeSql).toContain("$5::timestamptz <= now()+interval '5 minutes'");
  });
  it('keeps the first result on a timestamp tie and recovers small legacy future skew',async()=>{
    const f=setup({value:probe('fail',now-1000),observedAt:now-1000,receivedAt:now-1000});await f.send('tie',probe('ok',now-1000));expect(f.row?.value.result).toBe('fail');expect(f.probeSql).toContain('device_status.observed_at<excluded.observed_at');
    const legacy=setup({value:probe('ok',now-1000),observedAt:now-1000,receivedAt:now-1001});await legacy.send('recover-skew',probe('fail',now-2000));expect(legacy.row?.value.result).toBe('fail');
  });
  it('retains a raw event with an unrepresentable probe timestamp without sending an invalid Date to SQL',async()=>{
    const f=setup();const bad=probe('ok',8640000000000001);expect(await f.send('bad-probe',bad)).toBe('inserted');expect(JSON.parse(f.events.get('bad-probe')!).probes.dial).toEqual(bad);expect(f.probeSql).toBe('');expect(f.row).toBeUndefined();
  });
  it('rejects an unrepresentable direct event timestamp before opening a transaction',async()=>{
    let opened=false;const service=new DeviceEvents({connect:async()=>{opened=true;throw new Error('unexpected');}} as unknown as pg.Pool);
    expect(await service.handle('d',{id:'bad',type:'status.snapshot',ts:8640000000000001,payload:{}})).toBe('rejected');expect(opened).toBe(false);
  });
  it('projects valid probes from an older snapshot while leaving SIM state untouched',async()=>{
    const calls:string[]=[];const client={release(){},async query(sql:string){calls.push(sql);if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};if(sql.startsWith('SELECT id FROM device'))return {rowCount:1,rows:[{}]};if(sql.startsWith('INSERT INTO device_event'))return {rowCount:1,rows:[{}]};if(sql.startsWith('SELECT 1 FROM device_event'))return {rowCount:1,rows:[{}]};return {rowCount:0,rows:[]};}};
    const events=new DeviceEvents({connect:async()=>client} as unknown as pg.Pool);expect(await events.handle('d',{id:'corrected',type:'status.snapshot',ts:now,payload:{sims:[],simsAuthoritative:true,capabilityLevel:'L1',probes:{dial:probe('fail',now-1000)},permissions:[]}})).toBe('inserted');
    expect(calls.findIndex(sql=>sql.startsWith('INSERT INTO device_status'))).toBeLessThan(calls.findIndex(sql=>sql.startsWith('SELECT 1 FROM device_event')));expect(calls.some(sql=>sql.startsWith('UPDATE sim')||sql.startsWith('UPDATE device SET capability'))).toBe(false);
  });
  it('rejects probe times after their snapshot even if before server time',async()=>{
    const f=setup();await f.send('inconsistent',probe('ok',now-1000),now-2000);expect(f.row).toBeUndefined();
  });
});
