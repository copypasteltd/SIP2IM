import { expect, it, vi } from 'vitest';
import { SMS_ACTIVE_DEVICES, SMS_WAITING_WAKES, SmsDispatcher, type SmsCommandAck, type QueuedSms } from '../src/sms/dispatch.js';
import { SimRateLimiter } from '../src/sms/state.js';

const defer = <T>() => { let resolve!: (value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
const microtasks = async () => { for(let i=0;i<32;i++) await Promise.resolve(); };
const ok: SmsCommandAck = { ok:true, error:null };

it('admits at most four devices and coalesces waiting duplicates without moving their FIFO position', async()=>{
  const release = Array.from({length:SMS_ACTIVE_DEVICES+2},()=>defer<QueuedSms[]>());
  const ids = release.map((_,i)=>'device-'+i);
  const starts:string[]=[];
  let active=0, maximum=0;
  const queued=vi.fn(async(id:string)=>{
    starts.push(id); maximum=Math.max(maximum,++active);
    await release[ids.indexOf(id)]!.promise; active--;
    return [];
  });
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>true,send:async()=>ok},new SimRateLimiter());
  try {
    const writes=ids.map(id=>dispatcher.flush(id,null));
    await dispatcher.flush(ids[4]!,7);
    await microtasks();
    expect(starts).toEqual(ids.slice(0,4));
    release[2]!.resolve([]); await writes[2]; await microtasks();
    expect(starts).toEqual(ids.slice(0,5));
    release[1]!.resolve([]); await writes[1]; await microtasks();
    expect(starts).toEqual(ids);
    release.forEach(g=>g.resolve([])); await Promise.all(writes);
    expect(maximum).toBe(SMS_ACTIVE_DEVICES);
    expect(queued.mock.calls.filter(([id])=>id===ids[4])).toHaveLength(1);
  } finally { release.forEach(g=>g.resolve([])); await dispatcher.stop(); }
});

it('drops excess ordinary wake hints, then permits rediscovery without altering durable tasks',async()=>{
  const release=defer<QueuedSms[]>();
  const queued=vi.fn(async(_id:string)=>release.promise);
  const prepare=vi.fn(()=>null);
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>false,prepare}, new SimRateLimiter());
  const ids=Array.from({length:SMS_ACTIVE_DEVICES+SMS_WAITING_WAKES},(_,i)=>'device-'+i);
  try {
    const accepted=ids.map(id=>dispatcher.flush(id,null));
    let ordinarySettled=false;
    void dispatcher.flush('overflow',null).then(()=>{ordinarySettled=true;});
    await microtasks();
    expect(ordinarySettled).toBe(true);
    expect(queued.mock.calls.map(([id])=>id)).toEqual(ids.slice(0,SMS_ACTIVE_DEVICES));
    release.resolve([]); await Promise.all(accepted);
    expect(queued.mock.calls.map(([id])=>id)).toEqual(ids);
    await dispatcher.flush('overflow',null);
    expect(queued).toHaveBeenLastCalledWith('overflow');
    expect(prepare).not.toHaveBeenCalled();
  } finally { release.resolve([]); await dispatcher.stop(); }
});

it('drops waiting ordinary work on pause and rechecks using the new confirmed rate when rediscovered',async()=>{
  const release=defer<QueuedSms[]>();
  const queued=vi.fn(async(id:string)=>id==='waiting'?[{id:'next',deviceId:id,simId:'one',createdAt:1}]:release.promise);
  const limiter=new SimRateLimiter(()=>0);
  const send=vi.fn(async()=>ok);
  let confirmed=false;
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>confirmed,simState:async()=> 'ready',mark:async()=>true,send},limiter,()=>0);
  try {
    const admitted=Array.from({length:SMS_ACTIVE_DEVICES},(_,i)=>dispatcher.flush('active-'+i,null));
    const waiting=dispatcher.flush('waiting',null);
    await microtasks(); dispatcher.setRate(undefined);
    await waiting;
    expect(queued).not.toHaveBeenCalledWith('waiting');
    release.resolve([]); await Promise.all(admitted);
    await dispatcher.flush('waiting',null);
    expect(queued).not.toHaveBeenCalledWith('waiting');
    expect(send).not.toHaveBeenCalled();
    confirmed=true; dispatcher.setRate(2);
    const take=vi.spyOn(limiter,'take');
    await dispatcher.flush('waiting',null);
    expect(take).toHaveBeenCalledWith('one',2);
    expect(send).toHaveBeenCalledOnce();
  } finally { release.resolve([]); await dispatcher.stop(); }
});

it('gives the next device a slot after a slow ACK without resending the uncertain action or breaking SIM FIFO',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  const first=defer<SmsCommandAck>(), idle=defer<QueuedSms[]>();
  const submitted:string[]=[], projected:string[]=[];
  const tasks=['first','second'].map((id,i)=>({id,simId:'slot',deviceId:'slow',createdAt:i}));
  const states=new Map(tasks.map(t=>[t.id,'queued']));
  const queued=vi.fn(async(id:string)=>id==='slow'?tasks.filter(t=>states.get(t.id)==='queued'):id==='next'?[]:idle.promise);
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>false,prepare:task=>({
    claim:async()=>{states.set(task.id,'dispatched');return true;},
    send:()=>{submitted.push(task.id);return task.id==='first'?first.promise:Promise.resolve(ok);},
    acknowledge:async()=>{projected.push(task.id+':accepted');states.set(task.id,'accepted');},
    markUnknown:async()=>{projected.push(task.id+':unknown');states.set(task.id,'unknown');},
  })},new SimRateLimiter(Date.now),Date.now);
  try {
    const started=dispatcher.flush('slow',null);
    const other=Array.from({length:SMS_ACTIVE_DEVICES-1},(_,i)=>dispatcher.flush('other-'+i,null));
    const next=dispatcher.flush('next',null);
    await microtasks();
    expect(submitted).toEqual(['first']);
    expect(queued).not.toHaveBeenCalledWith('next');
    await vi.advanceTimersByTimeAsync(10_000);
    await started; await next;
    expect(projected).toEqual(['first:unknown']);
    expect(submitted).toEqual(['first']);
    expect(queued).toHaveBeenCalledWith('next');
    await vi.advanceTimersByTimeAsync(1);
    expect(submitted).toEqual(['first','second']);
    expect(projected).toEqual(['first:unknown','second:accepted']);
    const stopped=vi.fn(); const drained=dispatcher.stop().then(stopped);
    idle.resolve([]); await Promise.all(other);
    await microtasks(); expect(stopped).not.toHaveBeenCalled();
    first.resolve(ok); await drained;
    expect(projected).toEqual(['first:unknown','second:accepted']);
  } finally { idle.resolve([]); first.resolve(ok); await dispatcher.stop(); vi.useRealTimers(); }
});

it('continues on the other SIM after yielding even while the first SIM has an older backlog',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  const ack=defer<SmsCommandAck>(), idle=defer<QueuedSms[]>();
  const tasks=[{id:'a1',simId:'a',createdAt:0},{id:'a2',simId:'a',createdAt:1},{id:'b1',simId:'b',createdAt:100}]
    .map(task=>({...task,deviceId:'slow'}));
  const pending=new Set(tasks.map(t=>t.id)); const sent:string[]=[];
  const dispatcher=new SmsDispatcher({
    queued:async id=>id==='slow'?tasks.filter(task=>pending.has(task.id)):id==='next'?[]:idle.promise,
    canCommand:async()=>true,simState:async()=> 'ready',mark:async(id,from)=>from==='queued'?pending.delete(id):true,
    send:async task=>{sent.push(task.id);return task.id==='a1'?ack.promise:ok;},
  },new SimRateLimiter(Date.now),Date.now);
  try {
    const slow=dispatcher.flush('slow',null);
    const others=Array.from({length:SMS_ACTIVE_DEVICES-1},(_,i)=>dispatcher.flush('idle-'+i,null));
    const next=dispatcher.flush('next',null);
    await microtasks(); expect(sent).toEqual(['a1']);
    await vi.advanceTimersByTimeAsync(2_001); ack.resolve(ok);
    await slow; await next; expect(sent).toEqual(['a1']);
    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toEqual(['a1','b1','a2']);
    idle.resolve([]); await Promise.all(others);
  } finally { ack.resolve(ok); idle.resolve([]); await dispatcher.stop(); vi.useRealTimers(); }
});

it('retains the exact ACK settlement while paused, without another queue lookup or command send',async()=>{
  vi.useFakeTimers(); vi.setSystemTime(0);
  const task={id:'one',simId:'sim',deviceId:'device',createdAt:0};
  const queued=vi.fn(async()=>[task]); const send=vi.fn(async()=>ok);
  const persist=vi.fn<(ack:SmsCommandAck)=>Promise<void>>()
    .mockRejectedValueOnce(new Error('write failed')).mockResolvedValue(undefined);
  const unknown=vi.fn(async()=>{});
  const prepare=vi.fn(()=>({claim:async()=>true,send,acknowledge:persist,markUnknown:unknown}));
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>false,prepare},new SimRateLimiter(Date.now),Date.now);
  try {
    await expect(dispatcher.flush('device',null)).rejects.toThrow('write failed');
    dispatcher.setRate(undefined);
    await vi.advanceTimersByTimeAsync(1);
    expect(persist.mock.calls).toEqual([[ok],[ok]]);
    expect(queued).toHaveBeenCalledOnce();
    expect(prepare).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
    expect(unknown).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally { await dispatcher.stop(); vi.useRealTimers(); }
});

it('drains admitted work on stop but cancels unadmitted wakes without a database lookup',async()=>{
  const release=defer<QueuedSms[]>();
  const queued=vi.fn(async(_id:string)=>release.promise);
  const send=vi.fn(async()=>ok);
  const dispatcher=new SmsDispatcher({queued,canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>true,send},new SimRateLimiter());
  try {
    const active=Array.from({length:SMS_ACTIVE_DEVICES},(_,i)=>dispatcher.flush('busy-'+i,null));
    const deferred=dispatcher.flush('waiting',null);
    await microtasks();
    const stopped=vi.fn(), stop=dispatcher.stop().then(stopped);
    await deferred; await dispatcher.flush('late',null);
    expect(stopped).not.toHaveBeenCalled();
    expect(queued).toHaveBeenCalledTimes(SMS_ACTIVE_DEVICES);
    release.resolve([{id:'task',deviceId:'one',simId:'slot',createdAt:0}]);
    await Promise.all([...active,stop]);
    expect(stopped).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  } finally { release.resolve([]); await dispatcher.stop(); }
});
