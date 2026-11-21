import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {SmsDispatcher} from '../src/sms/dispatch.js';
import {SmsRepository} from '../src/sms/repo.js';
import {SmsQueueRepository} from '../src/sms/queue-repo.js';
import {markSmsAndNotify} from '../src/sms/task-events.js';
import {SimRateLimiter} from '../src/sms/state.js';

describe('database-authoritative dispatch expiry',()=>{
 it.each([{appNow:172800000,expired:false},{appNow:0,expired:true}])('obeys database expiry with app clock $appNow',async ({appNow,expired})=>{
  const states=new Map([['old','queued'],['new','queued']]);
  const tasks=[{id:'old',simId:'s',deviceId:'d',createdAt:0,expired},{id:'new',simId:'s',deviceId:'d',createdAt:1,expired:false}];
  const events:string[]=[];
  const dispatcher=new SmsDispatcher({queued:async()=>tasks,canCommand:async()=>true,simState:async()=> 'ready',mark:async(id,from,to,error)=>{if(states.get(id)!==from)return false;states.set(id,to);events.push(id+':'+to+':'+error);return true;},send:async task=>{events.push('send:'+task.id);return {ok:true,error:null};}},new SimRateLimiter(()=>appNow),()=>appNow);
  await dispatcher.flush('d',null);await dispatcher.stop();
  expect(events[0]).toBe(expired?'old:failed:DEVICE_OFFLINE':'old:dispatched:null');
  expect(events.includes('send:old')).toBe(!expired);
  expect(events.indexOf('send:new')).toBeGreaterThan(0);
 });
 it('blocks later tasks on the same SIM when an expiry transition loses its race',async()=>{
  const send=vi.fn(async(_task:{id:string})=>({ok:true,error:null}));
  const tasks=[{id:'old',simId:'s',deviceId:'d',createdAt:0,expired:true},{id:'new',simId:'s',deviceId:'d',createdAt:1},{id:'other',simId:'x',deviceId:'d',createdAt:2}];
  const d=new SmsDispatcher({queued:async()=>tasks,canCommand:async()=>true,simState:async()=> 'ready',mark:async id=>id!=='old',send},new SimRateLimiter());
  await d.flush('d',null);await d.stop();expect(send.mock.calls.map(([t])=>(t as {id:string}).id)).toEqual(['other']);
 });
 it('reads expiry from the database query',async()=>{
  const query=vi.fn(async(_sql:string)=>({rows:[{id:'t',createdAt:'3',expired:true}]}));
  const tasks=await new SmsQueueRepository({query} as unknown as pg.Pool).queued('d');
  expect(query.mock.calls[0]![0]).toContain("t.created_at<=now()-interval '24 hours' AS expired");expect(tasks[0]).toMatchObject({createdAt:3,expired:true});
 });
 it.each([true,false])('atomically checks expiry and replays/notifies only when update wins: %s',async wins=>{
  const query=vi.fn(async(sql:string)=>{
   if(sql==='COMMIT'||sql==='ROLLBACK')return {command:sql,rows:[],rowCount:0};
   if(sql.startsWith('SELECT id FROM sms_task'))return {rows:[{id:'t'}],rowCount:1};
   if(sql.startsWith('UPDATE sms_task SET state=$3'))return {rows:[],rowCount:wins?1:0};
   return {rows:[],rowCount:0};
  });
  const repo=new SmsRepository({connect:async()=>({query,release(){}})} as unknown as pg.Pool);
  const notify=vi.fn(async()=>{});
  expect(await markSmsAndNotify(()=>repo.changeState('t','queued','failed','DEVICE_OFFLINE'),notify,()=>{})).toBe(wins);
  const lockIndex=query.mock.calls.findIndex(([sql])=>sql.startsWith('SELECT id FROM sms_task'));
  const updateIndex=query.mock.calls.findIndex(([sql])=>sql.startsWith('UPDATE sms_task SET state=$3'));
  expect(query.mock.calls[lockIndex]![0]).toContain('FOR UPDATE');expect(lockIndex).toBeLessThan(updateIndex);
  const update=query.mock.calls[updateIndex]![0];
  expect(update).toContain("created_at<=clock_timestamp()-interval '24 hours'");expect(update).toContain("created_at>clock_timestamp()-interval '24 hours'");expect(update).toContain('local_failure=CASE');
  expect(query.mock.calls.some(([sql])=>sql.startsWith('SELECT e.payload'))).toBe(wins);expect(notify).toHaveBeenCalledTimes(wins?1:0);
 });
});
