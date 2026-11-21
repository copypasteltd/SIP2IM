import { afterEach, expect, it, vi } from 'vitest';
import { DeviceSessions, type DeviceSessionDeps } from '../src/ws-device/session.js';
import { DeviceCommands } from '../src/ws-device/commands.js';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const accepted = { id: deviceId, enabled: true };
const config = { heartbeatSec: 30, locale: 'en' };
const frame = (type: string, payload: unknown) => JSON.stringify({v:1,type,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload});
const hello = (token = 'fixture-device') => frame('hello',{token,apkVersion:'1',apkCode:1,protocol:1,manufacturer:'fixture',model:'fixture',apiLevel:19,locale:'en'});
const heartbeat = frame('heartbeat',{battery:null,charging:null,network:'wifi',signalDbm:null,shizuku:'running',paused:false});
const socket = () => ({readyState:1,send:vi.fn<(raw:string)=>void>(),close:vi.fn<(code:number)=>void>()});
const tick = () => new Promise<void>(done => setImmediate(done));
function deferred<T>() {
  let resolve!:(value:T)=>void, reject!:(cause:unknown)=>void;
  const promise = new Promise<T>((done,fail)=>{resolve=done;reject=fail;});
  return {promise,resolve,reject};
}
function fixture(overrides:Partial<DeviceSessionDeps> = {}) {
  // The monotonic sample can move independently from timer delivery.
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  let now = 0;
  const authenticate = vi.fn(async () => accepted), currentConfig = vi.fn(async () => config);
  const beat = vi.fn(async () => {}), observe = vi.fn(async () => {});
  const commands = new DeviceCommands(), attach = vi.spyOn(commands,'attach'), ready = vi.spyOn(commands,'configReady');
  const registry = new DeviceSessions({authenticate,currentConfig,heartbeat:beat,onEvent:async()=>true,heartbeatSec:30,locale:'en',commands,protocolAlerts:{observe},...overrides},()=>now);
  return {registry,clock:(value:number)=>{now=value;},authenticate,currentConfig,beat,observe,commands,attach,ready};
}
afterEach(()=>vi.useRealTimers());

it.each(['arrival','queued'] as const)('refuses an expired hello before a lookup (%s)', async when => {
  const f = fixture(), ws = socket(), session = f.registry.open(ws);
  f.clock(4999);
  const waiting = when==='queued' ? session.message(hello()) : undefined;
  f.clock(5000);
  await (waiting ?? session.message(hello()));
  expect(ws.close).toHaveBeenCalledExactlyOnceWith(4001);
  expect(f.authenticate).not.toHaveBeenCalled();
  expect(f.currentConfig).not.toHaveBeenCalled();
  expect(f.attach).not.toHaveBeenCalled();
  expect(ws.send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await f.registry.stop();
});

it.each(['allowed','refused','error'] as const)('drops first auth settling at the exact boundary before its timer (%s)', async outcome => {
  const auth = deferred<typeof accepted|null>(), authenticate = vi.fn(()=>auth.promise);
  const f = fixture({authenticate}), ws = socket(), session = f.registry.open(ws);
  const handshake = session.message(hello()), later = session.message(heartbeat);
  await tick();
  expect(authenticate).toHaveBeenCalledOnce();
  f.clock(5000);
  if(outcome==='error') auth.reject(Error('synthetic auth failure'));
  else auth.resolve(outcome==='allowed'?accepted:null);
  await Promise.all([handshake,later]);
  expect(ws.close).toHaveBeenCalledExactlyOnceWith(4001);
  expect(ws.send).not.toHaveBeenCalled();
  expect(f.currentConfig).not.toHaveBeenCalled();
  expect(f.beat).not.toHaveBeenCalled();
  expect(f.ready).not.toHaveBeenCalled();
  expect(f.observe).not.toHaveBeenCalled();
  await f.registry.stop();
});

it.each(['allowed','error'] as const)('late configuration leaves the incumbent active (%s)', async outcome => {
  const gate = deferred<typeof config>(), currentConfig = vi.fn(async()=>config).mockImplementationOnce(async()=>config).mockImplementationOnce(()=>gate.promise);
  const f = fixture({currentConfig}), live = socket(), joining = socket();
  const incumbent = f.registry.open(live);
  await incumbent.message(hello());
  const replacement = f.registry.open(joining), pending = replacement.message(hello());
  await tick();
  expect(currentConfig).toHaveBeenCalledTimes(2);
  f.clock(5000);
  if(outcome==='error') gate.reject(Error('synthetic config failure'));
  else gate.resolve(config);
  await pending;
  expect(joining.close).toHaveBeenCalledExactlyOnceWith(4001);
  expect(joining.send).not.toHaveBeenCalled();
  expect(live.close).not.toHaveBeenCalled();
  expect(f.attach.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(f.ready.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(f.commands.isConnected(deviceId)).toBe(true);
  await incumbent.message(heartbeat);
  expect(f.beat).toHaveBeenCalledOnce();
  expect(f.observe).toHaveBeenCalledOnce();
  await f.registry.stop();
});

it.each(['timer','lane'] as const)('an expired replacement cannot detach an incumbent whose lane is busy (%s)', async firstEffect => {
  const held = deferred<void>(), heartbeatFn = vi.fn(()=>held.promise);
  const f = fixture({heartbeat:heartbeatFn}), live = socket(), joining = socket();
  const incumbent = f.registry.open(live), replacement = f.registry.open(joining);
  await incumbent.message(hello());
  const inFlight = incumbent.message(heartbeat);
  await tick();
  expect(heartbeatFn).toHaveBeenCalledOnce();
  const pending = replacement.message(hello()), queued = replacement.message(heartbeat);
  await tick();
  expect(f.currentConfig).toHaveBeenCalledTimes(2);
  expect(joining.send).not.toHaveBeenCalled();
  f.clock(5000);
  if(firstEffect==='timer') {
    vi.advanceTimersByTime(5000);
    expect(joining.close).toHaveBeenCalledExactlyOnceWith(4001);
    expect(live.close).not.toHaveBeenCalled();
  }
  held.resolve();
  await Promise.all([inFlight,pending,queued]);
  expect(joining.close).toHaveBeenCalledExactlyOnceWith(4001);
  expect(joining.send).not.toHaveBeenCalled();
  expect(live.close).not.toHaveBeenCalled();
  expect(f.attach.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(f.ready.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(heartbeatFn).toHaveBeenCalledOnce();
  await f.registry.stop();
});

it.each(['auth','config'] as const)('retains only a timely newer authentication as the takeover high-water mark (%s)', async latePhase => {
  const newAuth = deferred<typeof accepted>(), oldConfig = deferred<typeof config>(), newConfig = deferred<typeof config>();
  const authenticate = vi.fn(async (_token:string)=>accepted).mockImplementation(token=>token==='newer'&&latePhase==='auth'?newAuth.promise:Promise.resolve(accepted));
  const configLookup = vi.fn(async()=>config).mockImplementationOnce(()=>oldConfig.promise).mockImplementationOnce(()=>newConfig.promise);
  const f = fixture({authenticate,currentConfig:configLookup});
  // This socket opens earlier but submits the newer hello, so its budget expires first.
  const b = socket(), sb=f.registry.open(b);
  f.clock(1000);
  const a = socket(), sa=f.registry.open(a), earlier=sa.message(hello('older'));
  await tick();
  expect(configLookup).toHaveBeenCalledOnce();
  const later=sb.message(hello('newer'));
  await tick();
  expect(authenticate.mock.calls).toEqual([['older'],['newer']]);
  expect(configLookup).toHaveBeenCalledTimes(latePhase==='config'?2:1);
  f.clock(5000);
  newAuth.resolve(accepted); newConfig.resolve(config);
  await later;
  expect(b.close).toHaveBeenCalledExactlyOnceWith(4001);
  oldConfig.resolve(config); await earlier;
  if(latePhase==='auth') {
    expect(a.close).not.toHaveBeenCalled();
    expect(a.send).toHaveBeenCalledOnce();
    expect(f.ready.mock.calls.map(call=>call[1])).toEqual([a]);
  } else {
    expect(a.close).toHaveBeenCalledExactlyOnceWith(4009);
    expect(a.send).not.toHaveBeenCalled();
    expect(f.ready).not.toHaveBeenCalled();
  }
  expect(b.send).not.toHaveBeenCalled();
  await f.registry.stop();
});

it('keeps a recorded revocation ahead of the timeout for an identified candidate', async () => {
  const cfg = deferred<typeof config>(), currentConfig = vi.fn(()=>cfg.promise);
  const f = fixture({currentConfig}), ws = socket(), waiting=f.registry.open(ws).message(hello());
  await tick();
  expect(currentConfig).toHaveBeenCalledOnce();
  f.registry.revoke(deviceId,4011);
  f.clock(5000); vi.advanceTimersByTime(5000);
  cfg.resolve(config); await waiting;
  expect(ws.close).toHaveBeenCalledExactlyOnceWith(4011);
  expect(ws.send).not.toHaveBeenCalled();
  expect(f.attach).not.toHaveBeenCalled();
  await f.registry.stop();
});

it('rearms an early timer only for the remainder and contains a transport close failure', async () => {
  const f = fixture(), ws = socket();
  const failure = Error('synthetic close failure');
  ws.close.mockImplementation(()=>{throw failure;});
  const session=f.registry.open(ws);
  f.clock(4250); vi.advanceTimersByTime(5000);
  expect(ws.close).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(1);
  f.clock(4999); vi.advanceTimersByTime(749);
  expect(ws.close).not.toHaveBeenCalled();
  f.clock(5000); expect(()=>vi.advanceTimersByTime(1)).not.toThrow();
  await session.message(hello());
  expect(ws.close).toHaveBeenCalledExactlyOnceWith(4001);
  expect(f.authenticate).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await expect(f.registry.stop()).rejects.toMatchObject({errors:[failure]});
  expect(ws.close).toHaveBeenCalledOnce();
});

it('queues timely hello before command attachment, then no longer applies the first-hello deadline', async () => {
  const gate = deferred<typeof config>();
  const f = fixture({currentConfig:()=>gate.promise}), ws = socket(), active=f.registry.open(ws);
  const work=active.message(hello()), queued=active.message(heartbeat);
  await tick();
  f.clock(4999);
  ws.send.mockImplementationOnce(raw=>{
    expect(JSON.parse(raw)).toMatchObject({type:'hello.ok',payload:{deviceId,config}});
    expect(f.commands.isConnected(deviceId)).toBe(false);
    f.clock(5000); // The reply already entered the synchronous send on time.
  });
  gate.resolve(config);
  await Promise.all([work,queued]);
  expect(f.commands.isConnected(deviceId)).toBe(true);
  expect(f.ready).toHaveBeenCalledExactlyOnceWith(deviceId,ws);
  expect(vi.getTimerCount()).toBe(0);
  f.clock(6000); vi.advanceTimersByTime(6000);
  await active.message(heartbeat);
  expect(ws.close).not.toHaveBeenCalled();
  expect(f.beat).toHaveBeenCalledTimes(2);
  await f.registry.stop();
  expect(ws.close).toHaveBeenCalledExactlyOnceWith(1001);
});

it('rechecks the deadline after a synchronous incumbent close callback', async () => {
  const f = fixture(), live=socket(), joining=socket();
  await f.registry.open(live).message(hello());
  const replacement=f.registry.open(joining);
  f.clock(4999);
  live.close.mockImplementationOnce(()=>{f.clock(5000);});
  await replacement.message(hello());
  expect(live.close).toHaveBeenCalledExactlyOnceWith(4009);
  expect(joining.close).toHaveBeenCalledExactlyOnceWith(4001);
  expect(joining.send).not.toHaveBeenCalled();
  expect(f.attach.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(f.ready.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(f.commands.isConnected(deviceId)).toBe(false);
  await f.registry.stop();
});

it('does not evict a current device for a candidate whose transport is already closing', async () => {
  const entered = deferred<void>(), cfg=deferred<typeof config>();
  const lookup=vi.fn(async()=>config).mockImplementationOnce(async()=>config).mockImplementationOnce(()=>{entered.resolve();return cfg.promise;});
  const f=fixture({currentConfig:lookup}), live=socket(), joining=socket();
  await f.registry.open(live).message(hello());
  const pending=f.registry.open(joining).message(hello()); await entered.promise;
  joining.readyState=2; cfg.resolve(config); await pending;
  expect(live.close).not.toHaveBeenCalled();
  expect(joining.close).not.toHaveBeenCalled();
  expect(joining.send).not.toHaveBeenCalled();
  expect(f.attach.mock.calls.map(call=>call[1])).toEqual([live]);
  expect(f.commands.isConnected(deviceId)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
  await f.registry.stop();
});
