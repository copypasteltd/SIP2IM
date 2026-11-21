import { expect, it, vi } from 'vitest';
import { SmsDispatcher, type PreparedSmsDispatch } from '../src/sms/dispatch.js';
import { SimRateLimiter } from '../src/sms/state.js';
import { DeviceCommands } from '../src/ws-device/commands.js';
import { DeviceSessions } from '../src/ws-device/session.js';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const first = {id:'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAV',simId:'sim',deviceId,createdAt:0};
const second = {...first,id:'tsk_01ARZ3NDEKTSV4RRFFQ69G5FAW',createdAt:1};
const env = (type: string, payload: unknown) => JSON.stringify({v:1,type,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload});
const hello = env('hello',{token:'test',apkVersion:'1',apkCode:1,protocol:1,manufacturer:'fake',model:'fake',apiLevel:19,locale:'en'});

it('sends the claimed ID through the active socket and projects its matching ACK', async () => {
  let state = 'queued';
  let committedId: string | undefined;
  let sentId: string | undefined;
  const commands = new DeviceCommands();
  const sessions = new DeviceSessions({authenticate:async()=>({id:deviceId,enabled:true}),heartbeat:async()=>{},onEvent:async()=>true,commands,heartbeatSec:30,locale:'en'});
  const session = sessions.open({close:()=>{},send:raw=>{
    const command = JSON.parse(raw);
    if (command.type === 'sms.send') {
      sentId = command.id;
      void session.message(env('ack',{refId:command.id,ok:true,error:null}));
    }
  }});
  await session.message(hello);
  const dispatcher = new SmsDispatcher({
    queued:async()=>state === 'queued' ? [first] : [], canCommand:async()=>true, simState:async()=> 'ready', mark:async()=>false,
    prepare(task) {
      const transport = commands.prepareSms(task.deviceId,{taskId:task.id,subId:null,slot:0,to:'fake',body:'test'})!;
      return {
        claim:async()=>{ expect(sentId).toBeUndefined(); committedId = transport.commandId; state = 'dispatched'; return true; },
        ackDeadline:'transport',
        send:transport.send,
        acknowledge:async ack =>{ expect(ack).toEqual({ok:true,error:null}); expect(sentId).toBe(committedId); state = 'accepted'; },
        markUnknown:async()=>{ state = 'unknown'; },
      };
    },
  },new SimRateLimiter());
  try {
    await dispatcher.flush(deviceId,null);
    expect(state).toBe('accepted');
  } finally {
    await dispatcher.stop();
    session.close();
  }
});

it.each([9999,10000])('projects only a timely ACK processed after a held device message (%d ms)', async processedAt => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now=0, state='queued', claimedId:string|undefined;
  const heartbeatEntered=deferred<void>(), release=deferred<void>(), sent=deferred<string>();
  const commands=new DeviceCommands(undefined,()=>now);
  const sessions=new DeviceSessions({authenticate:async()=>({id:deviceId,enabled:true}),heartbeat:async()=>{heartbeatEntered.resolve(); await release.promise;},onEvent:async()=>true,commands,heartbeatSec:30,locale:'en'},()=>now);
  const close=vi.fn();
  const send=vi.fn((raw:string)=>{
    const frame=JSON.parse(raw);
    if(frame.type==='sms.send') sent.resolve(frame.id);
  });
  const session=sessions.open({close,send});
  const settleAck=vi.fn(async (ref:string)=>{expect(ref).toBe(claimedId);state='accepted';});
  const settleUnknown=vi.fn(async (ref:string)=>{expect(ref).toBe(claimedId);state='unknown';});
  const prepare=vi.fn((task:typeof first):PreparedSmsDispatch=>{
    const transport=commands.prepareSms(task.deviceId,{taskId:task.id,subId:null,slot:0,to:'fake',body:'fixture'})!;
    return {ackDeadline:'transport',send:transport.send,
      claim:async()=>{claimedId=transport.commandId;state='dispatched';return true;},
      acknowledge:async()=>settleAck(transport.commandId),markUnknown:async()=>settleUnknown(transport.commandId)};
  });
  const dispatcher=new SmsDispatcher({queued:async()=>state==='queued'?[first]:[],canCommand:async()=>true,simState:async()=> 'ready',mark:async()=>false,prepare},new SimRateLimiter(()=>0),()=>0);
  try {
    await session.message(hello);
    const beat=session.message(env('heartbeat',{battery:null,charging:null,network:'wifi',signalDbm:null,shizuku:'running',paused:false}));
    await heartbeatEntered.promise;
    const flushing=dispatcher.flush(deviceId,null), ref=await sent.promise;
    expect(ref).toBe(claimedId);
    expect(vi.getTimerCount()).toBe(1); // Only the transport timer decides production ACK admission.
    const ack=env('ack',{refId:ref,ok:true,error:null});
    now=5000;
    const queued=session.message(ack);
    now=processedAt; // No timers delivered; the session still needs to process the ACK.
    release.resolve();
    await Promise.all([beat,queued,flushing]);
    expect(state).toBe(processedAt<10_000?'accepted':'unknown');
    expect(settleAck).toHaveBeenCalledTimes(processedAt<10_000?1:0);
    expect(settleUnknown).toHaveBeenCalledTimes(processedAt<10_000?0:1);
    await session.message(ack);
    await dispatcher.flush(deviceId,null);
    expect(prepare).toHaveBeenCalledOnce();
    expect(send.mock.calls.map(([raw])=>JSON.parse(raw).type)).toEqual(['hello.ok','sms.send']);
    expect(close).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    release.resolve(); session.close();
    try { await Promise.all([dispatcher.stop(),sessions.stop()]); }
    finally { vi.useRealTimers(); }
  }
});

function failureFixture(overrides: Partial<PreparedSmsDispatch>) {
  const tasks = new Set([first,second]);
  const events: string[] = [];
  const ack = { ok:false,error:'CONFLICT' };
  const send = vi.fn(async () => ack);
  const markUnknown = vi.fn(async () => { events.push('unknown'); });
  const acknowledge = vi.fn(async (_ack: typeof ack) => { events.push('ack'); });
  const firstAttempt = {claim:async()=>{tasks.delete(first);return true;},send,markUnknown,acknowledge,...overrides};
  const dispatcher = new SmsDispatcher({
    queued:async()=>[...tasks], canCommand:async()=>true, simState:async()=> 'ready', mark:async()=>false,
    prepare(task) {
      if (task.id === first.id) return firstAttempt;
      return {claim:async()=>{tasks.delete(second);events.push('claim second');return true;},send:async()=>ack,markUnknown:async()=>{},acknowledge:async()=>{}};
    },
  },new SimRateLimiter());
  return {dispatcher,events,send,markUnknown,acknowledge,firstAttempt,tasks};
}

it('settles an uncertain claim before admitting a later SMS on that device', async () => {
  const f = failureFixture({claim:async()=>{ f.tasks.delete(first); throw new Error('COMMIT reply lost'); }});
  try {
    await expect(f.dispatcher.flush(deviceId,null)).rejects.toThrow('COMMIT reply lost');
    expect(f.send).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
    await f.dispatcher.flush(deviceId,null);
    expect(f.events).toEqual(['unknown','claim second']);
    expect(f.send).not.toHaveBeenCalled();
  } finally { await f.dispatcher.stop(); }
});

it('retries only the exact ACK write and preserves order across persistence failure', async () => {
  let writes = 0;
  const f = failureFixture({acknowledge:async ack=>{
    expect(ack).toEqual({ok:false,error:'CONFLICT'});
    if (++writes === 1) throw new Error('ACK write failed');
    f.events.push('ACK persisted');
  }});
  try {
    await expect(f.dispatcher.flush(deviceId,null)).rejects.toThrow('ACK write failed');
    expect(f.events).toEqual([]);
    await f.dispatcher.flush(deviceId,null);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.markUnknown).not.toHaveBeenCalled();
    expect(f.events).toEqual(['ACK persisted','claim second']);
  } finally { await f.dispatcher.stop(); }
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

it('waits for a durable claim at shutdown and settles it without sending', async () => {
  const entered = deferred<void>(), release = deferred<boolean>();
  const f = failureFixture({claim: () => { entered.resolve(); return release.promise; }});
  const flushing = f.dispatcher.flush(deviceId, null);
  await entered.promise;
  const stopped = f.dispatcher.stop();
  release.resolve(true);
  await Promise.all([flushing, stopped]);
  expect(f.send).not.toHaveBeenCalled();
  expect(f.markUnknown).toHaveBeenCalledOnce();
  expect(f.events).toEqual(['unknown']);
});
