import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeviceSessions } from '../src/ws-device/session.js';
import { DeviceCommands } from '../src/ws-device/commands.js';

const id = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const message = (type:string, payload:unknown) => JSON.stringify({v:1,type,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload});
const hello = message('hello',{token:'x',apkVersion:'1',apkCode:1,protocol:1,manufacturer:'x',model:'x',apiLevel:19,locale:'en'});
const heartbeat = message('heartbeat',{battery:null,charging:null,network:'wifi',signalDbm:null,shizuku:'running',paused:false});
function deferred<T>() { let resolve!: (value:T) => void; const promise = new Promise<T>(r => {resolve=r;}); return {promise,resolve}; }
const pending = async (p:Promise<unknown>) => expect(await Promise.race([p.then(()=>'settled'),new Promise<string>(r=>setImmediate(()=>r('pending')))])).toBe('pending');
const socket = () => ({send:vi.fn(),close:vi.fn()});
afterEach(() => vi.useRealTimers());

describe('DeviceSessions stop', () => {
  it('blocks admission synchronously and waits for authentication and queued heartbeat', async () => {
    const auth = deferred<{id:string;enabled:boolean}|null>();
    const beat = deferred<void>();
    const entered = deferred<void>();
    const heartbeatFn = vi.fn(async()=>{entered.resolve(); await beat.promise;});
    const commands = new DeviceCommands();
    const ds = new DeviceSessions({authenticate:()=>auth.promise,heartbeat:heartbeatFn,onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const ws=socket(), s=ds.open(ws);
    const first=s.message(hello), second=s.message(heartbeat);
    const stop=ds.stop();
    expect(ds.stop()).toBe(stop);
    const rejected=socket(); const late=ds.open(rejected);
    await late.message(hello); await s.message(heartbeat);
    expect(rejected.close).toHaveBeenCalledWith(1001);
    await pending(stop);
    auth.resolve({id,enabled:true});
    await entered.promise;
    expect(commands.isConnected(id)).toBe(true);
    await pending(stop);
    beat.resolve(); await Promise.all([first,second,stop]);
    expect(heartbeatFn).toHaveBeenCalledTimes(1);
    expect(commands.isConnected(id)).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1001);
  });

  it('keeps a detached session tracked until its event finishes', async () => {
    const event = deferred<boolean>(), entered=deferred<void>();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}), heartbeat:async()=>{}, onEvent:async()=>{entered.resolve();return event.promise;},heartbeatSec:30,locale:'en'});
    const ws=socket(), s=ds.open(ws); await s.message(hello);
    const work=s.message(message('sms.received',{subId:null,slot:0,from:'test',fromKind:'short',body:'test',receivedAt:1,parts:1}));
    await entered.promise;
    s.close(); const stop=ds.stop(); await pending(stop);
    event.resolve(true); await Promise.all([work,stop]);
    expect(ws.send).toHaveBeenCalledTimes(1);
  });

  it('replaces the attached session after concurrent configuration lookups settle', async () => {
    const configA=deferred<{heartbeatSec:number;locale:string}>(), configB=deferred<{heartbeatSec:number;locale:string}>();
    const getConfig=vi.fn().mockReturnValueOnce(configA.promise).mockReturnValueOnce(configB.promise);
    const commands=new DeviceCommands();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en',commands,currentConfig:getConfig});
    const a=socket(), b=socket(), sa=ds.open(a), sb=ds.open(b);
    const wa=sa.message(hello), wb=sb.message(hello);
    await vi.waitFor(()=>expect(getConfig).toHaveBeenCalledTimes(2));
    configB.resolve({heartbeatSec:30,locale:'en'}); await wb;
    configA.resolve({heartbeatSec:30,locale:'en'}); await wa;
    expect(a.close).toHaveBeenCalledWith(4009);
    expect(b.close).not.toHaveBeenCalled();
    sa.close(); expect(commands.isConnected(id)).toBe(true);
    await ds.stop(); expect(commands.isConnected(id)).toBe(false);
  });

  it('keeps the newer hello when authentication completes in reverse order', async () => {
    const authA=deferred<{id:string;enabled:boolean}|null>(), authB=deferred<{id:string;enabled:boolean}|null>();
    const authenticate=vi.fn().mockReturnValueOnce(authA.promise).mockReturnValueOnce(authB.promise);
    const commands=new DeviceCommands();
    const ds=new DeviceSessions({authenticate,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const a=socket(), b=socket(), sa=ds.open(a), sb=ds.open(b);
    const wa=sa.message(hello), wb=sb.message(hello);
    await vi.waitFor(()=>expect(authenticate).toHaveBeenCalledTimes(2));
    authB.resolve({id,enabled:true}); await wb;
    authA.resolve({id,enabled:true}); await wa;
    expect(a.close).toHaveBeenCalledWith(4009); expect(a.send).not.toHaveBeenCalled();
    expect(b.close).not.toHaveBeenCalled(); expect(commands.isConnected(id)).toBe(true);
    await ds.stop();
  });

  it.each(['authentication','configuration'])('prevents attachment after revocation during %s', async phase => {
    const auth=deferred<{id:string;enabled:boolean}|null>(), config=deferred<{heartbeatSec:number;locale:string}>();
    const authenticate=vi.fn(()=>phase==='authentication' ? auth.promise : Promise.resolve({id,enabled:true}));
    const currentConfig=vi.fn(()=>config.promise), commands=new DeviceCommands();
    const ds=new DeviceSessions({authenticate,currentConfig,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const ws=socket(), s=ds.open(ws), work=s.message(hello);
    if (phase==='authentication') await vi.waitFor(()=>expect(authenticate).toHaveBeenCalledOnce());
    else await vi.waitFor(()=>expect(currentConfig).toHaveBeenCalledOnce());
    ds.revoke(id,4011);
    auth.resolve({id,enabled:true}); config.resolve({heartbeatSec:30,locale:'en'});
    await work;
    expect(ws.close).toHaveBeenCalledWith(4011); expect(ws.send).not.toHaveBeenCalled();
    expect(commands.isConnected(id)).toBe(false); await ds.stop();
  });

  it('detaches old commands and drains replaced in-flight work', async () => {
    const event=deferred<boolean>(), entered=deferred<void>(), commands=new DeviceCommands();
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent:async()=>{entered.resolve();return event.promise;},heartbeatSec:30,locale:'en',commands});
    const a=socket(), b=socket(), sa=ds.open(a), sb=ds.open(b); await sa.message(hello);
    const outstanding=commands.send(id,'test',{}); const failure=expect(outstanding).rejects.toThrow('disconnected');
    const work=sa.message(message('sms.received',{subId:null,slot:0,from:'test',fromKind:'short',body:'test',receivedAt:1,parts:1}));
    await entered.promise; await sb.message(hello); await failure;
    expect(a.close).toHaveBeenCalledWith(4009); expect(commands.isConnected(id)).toBe(true);
    const stop=ds.stop(); await pending(stop); event.resolve(true); await Promise.all([work,stop]);
    expect(a.send).toHaveBeenCalledTimes(2); expect(commands.isConnected(id)).toBe(false);
  });

  it('cancels the handshake timer during a slow authentication', async () => {
    vi.useFakeTimers();
    const auth=deferred<{id:string;enabled:boolean}|null>();
    const ds=new DeviceSessions({authenticate:()=>auth.promise,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const ws=socket(), s=ds.open(ws); const work=s.message(hello);
    await Promise.resolve(); const stop=ds.stop();
    await vi.advanceTimersByTimeAsync(6000);
    expect(ws.close).not.toHaveBeenCalled();
    auth.resolve({id,enabled:true}); await Promise.all([work,stop]);
    expect(ws.close).toHaveBeenCalledOnce(); expect(ws.close).toHaveBeenCalledWith(1001);
  });

  it('remembers detach failure even when the session has already closed', async () => {
    const commands=new DeviceCommands();
    const detach=vi.spyOn(commands,'detach').mockImplementation(()=>{throw new Error('detach failed');});
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const s=ds.open(socket()); await s.message(hello);
    expect(()=>s.close()).toThrow('detach failed');
    await expect(ds.stop()).rejects.toThrow('device session shutdown failed');
    expect(detach).toHaveBeenCalledOnce();
  });

  it('attempts socket close even when command detach fails and reports both errors', async () => {
    const commands=new DeviceCommands(), detachError=new Error('detach failed'), closeError=new Error('close failed');
    vi.spyOn(commands,'detach').mockImplementation(()=>{throw detachError;});
    const ds=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const ws=socket(), s=ds.open(ws); await s.message(hello);
    ws.close.mockImplementation(()=>{throw closeError;});
    let error:unknown; try { ds.revoke(id); } catch (e) { error=e; }
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).errors).toEqual([detachError,closeError]);
    expect(ws.close).toHaveBeenCalledWith(4010);
    await expect(ds.stop()).rejects.toMatchObject({errors: expect.arrayContaining([detachError,closeError])});
  });

  it('retains fencing until unknown in-flight handshakes settle, then clears it', async () => {
    const auth=deferred<{id:string;enabled:boolean}|null>();
    const authenticate=vi.fn().mockReturnValueOnce(auth.promise).mockResolvedValue({id,enabled:true});
    const ds=new DeviceSessions({authenticate,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const old=socket(), newer=socket(), oldSession=ds.open(old), newerSession=ds.open(newer);
    const oldWork=oldSession.message(hello);
    await vi.waitFor(()=>expect(authenticate).toHaveBeenCalledOnce());
    await newerSession.message(hello); newerSession.close();
    ds.revoke(id,4011);
    const internals=ds as unknown as {revocations:Map<string,unknown>;latestAuthenticated:Map<string,unknown>};
    expect(internals.revocations.size).toBe(1); expect(internals.latestAuthenticated.size).toBe(1);
    auth.resolve({id,enabled:true}); await oldWork;
    expect(old.close).toHaveBeenCalledWith(4011);
    expect(internals.revocations.size).toBe(0); expect(internals.latestAuthenticated.size).toBe(0);
    await ds.stop();
  });

  it.each(['auth first','config first'])('keeps revocation fences with simultaneous pending auth and config: %s', async order => {
    const auth=deferred<{id:string;enabled:boolean}|null>(), config=deferred<{heartbeatSec:number;locale:string}>();
    const authenticate=vi.fn().mockReturnValueOnce(auth.promise).mockResolvedValue({id,enabled:true});
    const currentConfig=vi.fn(()=>config.promise), commands=new DeviceCommands();
    const ds=new DeviceSessions({authenticate,currentConfig,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en',commands});
    const a=socket(), b=socket(), wa=ds.open(a).message(hello), wb=ds.open(b).message(hello);
    await vi.waitFor(()=>expect(currentConfig).toHaveBeenCalledOnce());
    const internals=ds as unknown as {revocations:Map<string,unknown>;latestAuthenticated:Map<string,unknown>};
    ds.revoke(id,4011);
    expect(internals.revocations.size).toBe(1); expect(internals.latestAuthenticated.size).toBe(1);
    if (order==='auth first') {
      auth.resolve({id,enabled:true}); await wa;
    } else {
      config.resolve({heartbeatSec:30,locale:'en'}); await wb;
    }
    expect(internals.revocations.size).toBe(1); expect(internals.latestAuthenticated.size).toBe(1);
    auth.resolve({id,enabled:true}); config.resolve({heartbeatSec:30,locale:'en'});
    await Promise.all([wa,wb]);
    expect(a.close).toHaveBeenCalledWith(4011); expect(b.close).toHaveBeenCalledWith(4011);
    expect(a.send).not.toHaveBeenCalled(); expect(b.send).not.toHaveBeenCalled();
    expect(commands.isConnected(id)).toBe(false);
    expect(internals.revocations.size).toBe(0); expect(internals.latestAuthenticated.size).toBe(0);
    await ds.stop();
  });

  it('reports cleanup failures after trying every socket', async () => {
    const ds=new DeviceSessions({authenticate:async()=>null,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
    const first=socket(), second=socket(); first.close.mockImplementation(()=>{throw new Error('close failed');});
    ds.open(first); ds.open(second);
    await expect(ds.stop()).rejects.toThrow('device session shutdown failed');
    expect(second.close).toHaveBeenCalledWith(1001);
  });
});
