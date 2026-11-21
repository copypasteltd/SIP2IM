import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {SmsCreateRepository} from '../src/sms/create.js';
import {SmsRepository} from '../src/sms/repo.js';
import {SmsDispatcher} from '../src/sms/dispatch.js';
import {SimRateLimiter} from '../src/sms/state.js';

function fake(respond:(sql:string,args:unknown[])=>{rowCount:number;rows:unknown[]}) {
 const query=vi.fn(async(sql:string,args:unknown[]=[])=>{if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};if(sql.includes('WHERE t.idempotency_key') && !respond(sql,args).rows.some(row=>typeof row==='object' && row!==null && 'simId' in row))return {rowCount:0,rows:[]};if(sql.startsWith('SELECT e.payload'))return {rowCount:0,rows:[]};return respond(sql,args);});
 const client={query,release:vi.fn()};
 return {query,pool:{connect:async()=>client} as unknown as pg.Pool};
}
const yes={rowCount:1,rows:[{id:'d'}]};const no={rowCount:0,rows:[]};

describe('SMS eligibility',()=>{
 it('replays existing idempotency keys even after device or SIM becomes ineligible',async()=>{
  const f=fake(sql=>sql.includes('WHERE t.idempotency_key')?{rowCount:1,rows:[{id:'m',deviceId:'d',simId:'s',direction:'out',origin:'admin',peer:'123',body:'body'}]}:yes);
  const repo=new SmsCreateRepository(f.pool);
  expect(await repo.create('key','s','123','body')).toMatchObject({deviceId:'d',conflict:false});
  expect(await repo.create('key','s','456','body')).toMatchObject({conflict:true});
  expect(f.query.mock.calls.some(([sql])=>sql.includes('FROM device WHERE'))).toBe(false);
 });
 it.each(['device','sim'])('refuses new tasks if %s is ineligible after locking',async blocked=>{
  const f=fake(sql=>sql.startsWith('SELECT device_id FROM sim')?{rowCount:1,rows:[{device_id:'d'}]}:sql.startsWith('SELECT id FROM device')&&blocked==='device'?no:sql.startsWith('SELECT id FROM sim WHERE')&&blocked==='sim'?no:yes);
  expect(await new SmsCreateRepository(f.pool).create('key','s','123','body')).toBeNull();
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO sms_'))).toBe(false);
  expect(f.query.mock.calls.find(([sql])=>sql.startsWith('SELECT id FROM device'))?.[0]).toContain('FOR UPDATE');
 });
 it('permits eligible offline devices and locks device before SIM',async()=>{
  let inserted=false;
  const f=fake(sql=>{
   if(sql.startsWith('INSERT INTO sms_task'))inserted=true;
   if(sql.includes('WHERE t.idempotency_key'))return inserted?{rowCount:1,rows:[{id:'m',deviceId:'d',simId:'s',peer:'123',peerKind:'short',body:'body',parts:1,occurredAt:'42',taskId:'t',state:'queued',errorCode:null,origin:'admin',updatedAt:'42'}]}:no;
   return sql.startsWith('SELECT device_id FROM sim')?{rowCount:1,rows:[{device_id:'d'}]}:yes;
  });
  expect(await new SmsCreateRepository(f.pool).create('key','s','123','body')).toMatchObject({deviceId:'d',conflict:false});
  const sql=f.query.mock.calls.map(([q])=>q);const d=sql.findIndex(q=>q.startsWith('SELECT id FROM device'));const s=sql.findIndex(q=>q.startsWith('SELECT id FROM sim WHERE'));
  expect(d).toBeLessThan(s);expect(sql[d]).not.toContain('online');expect(sql[s]).toContain('FOR UPDATE');
 });
 it.each(['device','sim','owner'])('does not claim if locked %s eligibility changed',async blocked=>{
  const f=fake(sql=>sql.startsWith('SELECT id FROM device')&&blocked==='device'?no:sql.startsWith('SELECT id FROM sim')&&blocked==='sim'?no:sql.startsWith('SELECT 1 FROM sms_task')&&blocked==='owner'?no:yes);
  expect(await new SmsRepository(f.pool).changeState('t','queued','dispatched',null,{deviceId:'d',simId:'s',slot:0,subId:7})).toBe(false);
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE sms_task'))).toBe(false);
 });
 it('keeps queued when an unavailable SIM becomes ready before failure claim',async()=>{
  const f=fake(sql=>sql.startsWith('SELECT id FROM sim')?no:yes);
  expect(await new SmsRepository(f.pool).changeState('t','queued','failed','SIM_NOT_READY',{deviceId:'d',simId:'s'})).toBe(false);
  const calls=f.query.mock.calls;expect(calls.find(([q])=>q.startsWith('SELECT id FROM sim'))?.[0]).toContain("state IN ('absent','locked')");expect(calls.some(([q])=>q.startsWith('UPDATE sms_task'))).toBe(false);
 });
 it('returns the rate token when an eligibility claim fails',async()=>{
  const send=vi.fn(async()=>({ok:true,error:null}));let attempts=0;
  const dispatcher=new SmsDispatcher({queued:async()=>[{id:'t',simId:'s',deviceId:'d',createdAt:0}],canCommand:async()=>true,simState:async()=> 'ready',mark:async(_id,from,to)=>from==='queued'&&to==='dispatched'?++attempts>1:true,send},new SimRateLimiter(()=>1),()=>1);
  await dispatcher.flush('d',1);await dispatcher.flush('d',1);expect(attempts).toBe(2);expect(send).toHaveBeenCalledTimes(1);await dispatcher.stop();
 });
 it.each(['unavailable','claim'])('does not overtake a failed %s recheck, while other SIMs progress',async kind=>{
  const send=vi.fn(async(_task:{id:string;simId:string;deviceId:string;createdAt:number})=>({ok:true,error:null}));
  const tasks=[{id:'old',simId:'s',deviceId:'d',createdAt:0},{id:'new',simId:'s',deviceId:'d',createdAt:1},{id:'other',simId:'other',deviceId:'d',createdAt:2}];
  const d=new SmsDispatcher({queued:async()=>tasks,canCommand:async()=>true,simState:async id=>id==='s'&&kind==='unavailable'?'unavailable':'ready',mark:async(id,from,to)=>!(id==='old'&&from==='queued'&&(to==='failed'||to==='dispatched')),send},new SimRateLimiter(()=>10),()=>10);
  await d.flush('d',null);expect(send.mock.calls.map(([task])=>task.id)).toEqual(['other']);await d.stop();
 });
 it('uses a newer rate during an active flush',async()=>{
  let release!:()=>void;let entered!:()=>void;const gate=new Promise<void>(r=>{release=r});const started=new Promise<void>(r=>{entered=r});
  const send=vi.fn(async()=>({ok:true,error:null}));const tasks=[{id:'a',simId:'s',deviceId:'d',createdAt:0},{id:'b',simId:'s',deviceId:'d',createdAt:1}];let reads=0;
  const d=new SmsDispatcher({queued:async()=>{if(++reads===1){entered();await gate;return tasks}return [];},canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>true,send},new SimRateLimiter(()=>10),()=>10);
  const first=d.flush('d',null);await started;await d.flush('d',1);release();await first;expect(send).toHaveBeenCalledTimes(1);await d.stop();
 });
 it('claims only with current locked device, SIM and exact queued metadata',async()=>{
  const f=fake(()=>yes);
  expect(await new SmsRepository(f.pool).changeState('t','queued','dispatched',null,{deviceId:'d',simId:'s',slot:0,subId:7})).toBe(true);
  const calls=f.query.mock.calls;const d=calls.findIndex(([q])=>q.startsWith('SELECT id FROM device'));const s=calls.findIndex(([q])=>q.startsWith('SELECT id FROM sim'));const u=calls.findIndex(([q])=>q.startsWith('UPDATE sms_task'));
  expect(d).toBeLessThan(s);expect(s).toBeLessThan(u);expect(calls[d]![0]).toMatch(/online=true.*enabled=true.*paused=false.*revoked_at IS NULL FOR UPDATE/);
  expect(calls[s]![0]).toContain("last_seen_at >= now()-interval '2 hours'");expect(calls[s]![0]).toContain('sub_id IS NOT DISTINCT FROM $4 FOR UPDATE');expect(calls[s]![1]).toEqual(['s','d',0,7]);
 });
});
