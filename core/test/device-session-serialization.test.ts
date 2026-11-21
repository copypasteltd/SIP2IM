import { describe, expect, it, vi } from 'vitest';
import { DeviceSessions } from '../src/ws-device/session.js';
import { DeviceCommands } from '../src/ws-device/commands.js';

const id = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const otherId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAW';
const msg = (type:string, payload:unknown) => JSON.stringify({v:1,type,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload});
const hello = (token='x') => msg('hello',{token,apkVersion:'1',apkCode:1,protocol:1,manufacturer:'x',model:'x',apiLevel:19,locale:'en'});
const heartbeat = msg('heartbeat',{battery:null,charging:null,network:'wifi',signalDbm:null,shizuku:'running',paused:false});
const event = msg('sms.received',{subId:null,slot:0,from:'test',fromKind:'short',body:'test',receivedAt:1,parts:1});
function deferred<T>() { let resolve!:(value:T)=>void, reject!:(error:unknown)=>void; const promise=new Promise<T>((r,j)=>{resolve=r;reject=j;}); return {promise,resolve,reject}; }
const socket = () => ({send:vi.fn(),close:vi.fn()});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('device session serialization', () => {
  it('waits for an old heartbeat commit before replacement while other devices progress', async () => {
    const gate=deferred<void>(), entered=deferred<void>(), order:string[]=[];
    const ds=new DeviceSessions({authenticate:async token=>({id:token==='other'?otherId:id,enabled:true}),heartbeat:async device=>{order.push('heartbeat start'); entered.resolve(); await gate.promise; order.push('heartbeat commit');},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const a=socket(), b=socket(), c=socket(), sa=ds.open(a), sb=ds.open(b), sc=ds.open(c);
    await sa.message(hello()); const beat=sa.message(heartbeat); await entered.promise;
    const replacement=sb.message(hello()); await sc.message(hello('other')); await tick();
    expect(b.send).not.toHaveBeenCalled(); expect(a.close).not.toHaveBeenCalled();
    expect(c.send).toHaveBeenCalledOnce();
    gate.resolve(); await Promise.all([beat,replacement]); order.push('hello observed');
    expect(order).toEqual(['heartbeat start','heartbeat commit','hello observed']);
    expect(a.close).toHaveBeenCalledWith(4009); expect(b.send).toHaveBeenCalledOnce();
    await ds.stop();
    expect((ds as unknown as {deviceLanes:Map<string,unknown>}).deviceLanes.size).toBe(0);
  });

  it('skips a queued old heartbeat after replacement and does not detach the new socket on stale close', async () => {
    const gate=deferred<void>(), entered=deferred<void>();
    const heartbeatFn=vi.fn(async()=>{entered.resolve(); await gate.promise;}), commands=new DeviceCommands();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:heartbeatFn,onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const a=socket(), b=socket(), sa=ds.open(a), sb=ds.open(b); await sa.message(hello());
    const first=sa.message(heartbeat); await entered.promise;
    const activation=sb.message(hello()); await tick();
    const beat=sa.message(heartbeat); gate.resolve(); await Promise.all([first,activation,beat]);
    expect(heartbeatFn).toHaveBeenCalledOnce(); sa.close();
    expect(commands.isConnected(id)).toBe(true); expect(b.close).not.toHaveBeenCalled();
    await ds.stop();
  });

  it('releases the lane on heartbeat rejection and preserves the newer session', async () => {
    const gate=deferred<void>(), entered=deferred<void>();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{entered.resolve();await gate.promise;},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const a=socket(),b=socket(),sa=ds.open(a),sb=ds.open(b); await sa.message(hello());
    const beat=sa.message(heartbeat); await entered.promise; const replacement=sb.message(hello()); await tick();
    gate.reject(new Error('database failed')); await Promise.all([beat,replacement]);
    expect(a.close).toHaveBeenCalledOnce(); expect(a.close).toHaveBeenCalledWith(4009); expect(b.send).toHaveBeenCalledOnce();
    await ds.stop(); expect((ds as unknown as {deviceLanes:Map<string,unknown>}).deviceLanes.size).toBe(0);
  });

  it('closes an active socket with 1011 when its heartbeat fails', async () => {
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{throw new Error('database failed');},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const ws=socket(), s=ds.open(ws); await s.message(hello()); await s.message(heartbeat);
    expect(ws.close).toHaveBeenCalledWith(1011); await ds.stop();
    expect((ds as unknown as {deviceLanes:Map<string,unknown>}).deviceLanes.size).toBe(0);
  });

  it('honors revocation while replacement waits and drains without sending hello', async () => {
    const gate=deferred<void>(), entered=deferred<void>();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{entered.resolve();await gate.promise;},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const a=socket(),b=socket(),sa=ds.open(a),sb=ds.open(b); await sa.message(hello());
    const beat=sa.message(heartbeat); await entered.promise; const activation=sb.message(hello()); await tick();
    ds.revoke(id,4011); gate.resolve(); await Promise.all([beat,activation]);
    expect(a.close).toHaveBeenCalledWith(4011); expect(b.close).toHaveBeenCalledWith(4011); expect(b.send).not.toHaveBeenCalled();
    await ds.stop();
  });

  it('selects the latest authenticated hello waiting behind a heartbeat', async () => {
    const gate=deferred<void>(), entered=deferred<void>();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{entered.resolve(); await gate.promise;},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const a=socket(),b=socket(),c=socket(),sa=ds.open(a),sb=ds.open(b),sc=ds.open(c);
    await sa.message(hello()); const beat=sa.message(heartbeat); await entered.promise;
    const wb=sb.message(hello()); await tick(); const wc=sc.message(hello()); await tick();
    gate.resolve(); await Promise.all([beat,wb,wc]);
    expect(b.close).toHaveBeenCalledWith(4009); expect(b.send).not.toHaveBeenCalled();
    expect(c.send).toHaveBeenCalledOnce(); await ds.stop();
  });

  it('drains a closed heartbeat and waiting activation during stop', async () => {
    const gate=deferred<void>(), entered=deferred<void>();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{entered.resolve(); await gate.promise;},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const a=socket(),b=socket(),sa=ds.open(a),sb=ds.open(b);
    await sa.message(hello()); const beat=sa.message(heartbeat); await entered.promise;
    const activation=sb.message(hello()); await tick(); sb.close(); const stop=ds.stop();
    gate.resolve(); await Promise.all([beat,activation,stop]);
    expect(b.send).not.toHaveBeenCalled(); expect(a.close).toHaveBeenCalledWith(1001);
    expect((ds as unknown as {deviceLanes:Map<string,unknown>}).deviceLanes.size).toBe(0);
  });

  it('honors synchronous revocation reentered from old socket close', async () => {
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const a=socket(),b=socket(),sa=ds.open(a),sb=ds.open(b); await sa.message(hello());
    a.close.mockImplementation(()=>ds.revoke(id,4011)); await sb.message(hello());
    expect(b.close).toHaveBeenCalledWith(4011); expect(b.send).not.toHaveBeenCalled(); await ds.stop();
  });

  it('keeps event acknowledgements and command acknowledgements working', async () => {
    const commands=new DeviceCommands(), onEvent=vi.fn(async()=>true);
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent,heartbeatSec:30,locale:'en',commands});
    const ws=socket(), s=ds.open(ws); await s.message(hello()); await s.message(event);
    expect(JSON.parse(ws.send.mock.calls[1]![0]).type).toBe('ack');
    const outstanding=commands.send(id,'test',{}); const command=JSON.parse(ws.send.mock.calls[2]![0]);
    await s.message(msg('ack',{refId:command.id,ok:true,error:null}));
    await expect(outstanding).resolves.toEqual({ok:true,error:null});
    await ds.stop();
  });
});
