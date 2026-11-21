import type pg from 'pg';
import {afterEach,expect,it,vi} from 'vitest';
import {SmsDispatcher,type QueuedSms,type SmsDispatchPorts} from '../src/sms/dispatch.js';
import {SmsQueueRepository,SMS_QUEUE_PER_SIM,type DispatchRecord} from '../src/sms/queue-repo.js';
import {SimRateLimiter} from '../src/sms/state.js';

afterEach(()=>vi.useRealTimers());
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return {promise,resolve};};
const row=(simId:string,i:number,createdAt=i):DispatchRecord=>({id:simId+i,simId,deviceId:'device',createdAt,slot:simId==='a'?0:1,subId:null,to:'synthetic',body:'synthetic'});
const ids=(tasks:QueuedSms[])=>tasks.map(t=>t.id);

it('queries a FIFO page plus lookahead for each active SIM without a global head-of-line limit',async()=>{
  const rows=[...Array.from({length:SMS_QUEUE_PER_SIM+1},(_,i)=>row('a',i)),row('b',0,100)];
  const query=vi.fn(async(_sql:string,_args:unknown[])=>({rows}));
  const repo=new SmsQueueRepository({query} as unknown as pg.Pool);
  const page=await repo.queued('device');
  expect(query.mock.calls[0]![0]).toContain('JOIN LATERAL');
  expect(query.mock.calls[0]![0]).toMatch(/m.sim_id=s.id[\s\S]*ORDER BY q.created_at,q.id LIMIT \$2/);
  expect(query.mock.calls[0]![1]).toEqual(['device',SMS_QUEUE_PER_SIM+1]);
  expect(page).toHaveLength(SMS_QUEUE_PER_SIM+1);
  expect(page.filter(t=>t.moreForSim).map(t=>t.id)).toEqual(['a'+(SMS_QUEUE_PER_SIM-1)]);
  expect(page.at(-1)?.id).toBe('b0');
});

it('treats only a persisted null as unlimited and fails closed on a missing or invalid setting',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[]}).mockResolvedValueOnce({rows:[{value:0}]}).mockResolvedValueOnce({rows:[{value:null}]}).mockResolvedValueOnce({rows:[{value:2}]});
  const repo=new SmsQueueRepository({query} as unknown as pg.Pool);
  await expect(repo.rate()).rejects.toThrow('Persisted SMS rate is missing or invalid');
  await expect(repo.rate()).rejects.toThrow('Persisted SMS rate is missing or invalid');
  await expect(repo.rate()).resolves.toBeNull();
  await expect(repo.rate()).resolves.toBe(2);
});

it('serves a newer SIM between older tasks on another SIM and yields after a bounded page',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  const remaining=new Map([...Array.from({length:SMS_QUEUE_PER_SIM+2},(_,i)=>row('a',i)),row('b',0,100)].map(t=>[t.id,t]));
  const sent:string[]=[];
  const queued=vi.fn(async()=>{
    const a=[...remaining.values()].filter(t=>t.simId==='a');
    return [...a.slice(0,SMS_QUEUE_PER_SIM).map((t,i)=>({...t,moreForSim:i===SMS_QUEUE_PER_SIM-1&&a.length>SMS_QUEUE_PER_SIM})),...([...remaining.values()].filter(t=>t.simId==='b'))];
  });
  const ports:SmsDispatchPorts={queued,canCommand:async()=>true,simState:async()=> 'ready',mark:async(id,from)=>{if(from==='queued') remaining.delete(id);return true;},send:async t=>{sent.push(t.id);return {ok:true,error:null};}};
  const dispatcher=new SmsDispatcher(ports,new SimRateLimiter());
  try{
    await dispatcher.flush('device',null);
    expect(sent.slice(0,4)).toEqual(['a0','b0','a1','a2']);
    expect(sent).toHaveLength(SMS_QUEUE_PER_SIM+1);
    expect(queued).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(sent.slice(-2)).toEqual(['a'+SMS_QUEUE_PER_SIM,'a'+(SMS_QUEUE_PER_SIM+1)]);
    expect(queued).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  }finally{await dispatcher.stop();}
});

it("does not spend another SIM's turn or spin on a blocked SIM with lookahead",async()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  const tasks=[{...row('a',0),moreForSim:true},row('b',0,10)];
  const send=vi.fn(async(_task:QueuedSms)=>({ok:true,error:null}));
  const queued=vi.fn(async()=>tasks);
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>true,simState:async id=>id==='a'?'unknown':'ready',mark:async()=>true,send},new SimRateLimiter());
  try{
    await dispatcher.flush('device',null);
    expect(ids(send.mock.calls.map(([task])=>task))).toEqual(['b0']);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(queued).toHaveBeenCalledOnce();
  }finally{await dispatcher.stop();}
});

it('moves an existing refill timer to the confirmed rate and ignores a stale direct rate argument',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  const remaining=new Map([row('a',0),row('a',1)].map(t=>[t.id,t]));
  const send=vi.fn(async(_task:QueuedSms)=>({ok:true,error:null}));
  const currentRate=vi.fn(async()=>null);
  const dispatcher=new SmsDispatcher({queued:async()=>[...remaining.values()],canCommand:async()=>true,simState:async()=> 'ready',mark:async(id,from)=>{if(from==='queued') remaining.delete(id);return true;},send,currentRate},new SimRateLimiter());
  try{
   dispatcher.setRate(1);
   await dispatcher.flush('device',null);
   expect(ids(send.mock.calls.map(([task])=>task))).toEqual(['a0']);
   await vi.advanceTimersByTimeAsync(10_000);
   dispatcher.setRate(2);
   // At the instant of the change only 1/6 token was accrued. The remaining
   // 5/6 is at the new refill rate, so the wake moves from 60s to 35s.
   await vi.advanceTimersByTimeAsync(24_999);
   expect(send).toHaveBeenCalledOnce();
   await vi.advanceTimersByTimeAsync(2);
   expect(ids(send.mock.calls.map(([task])=>task))).toEqual(['a0','a1']);
   expect(currentRate).not.toHaveBeenCalled();
  }finally{await dispatcher.stop();}
});

it.each([false,true])('never transmits a claim that crosses a rate pause (reloaded=%s)',async(reloaded)=>{
  const task=row('a',0), claim=deferred<boolean>(), entered=deferred<void>();
  const send=vi.fn(async()=>({ok:true,error:null})), markUnknown=vi.fn(async()=>{});
  let state='queued';
  const dispatcher=new SmsDispatcher({queued:async()=>state==='queued'?[task]:[],canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>false,prepare:()=>({claim:async()=>{entered.resolve();await claim.promise;state='dispatched';return true;},send,acknowledge:async()=>{},markUnknown:async()=>{state='unknown';await markUnknown();}})},new SimRateLimiter());
  try {
    dispatcher.setRate(null);
    const flushing=dispatcher.flush('device',null);
    await entered.promise;
    dispatcher.setRate(undefined);
    if (reloaded) dispatcher.setRate(1);
    claim.resolve(true); await flushing;
    expect(state).toBe('unknown'); expect(markUnknown).toHaveBeenCalledOnce();
    await dispatcher.flush('device',null); expect(send).not.toHaveBeenCalled();
  } finally { await dispatcher.stop(); }
});
