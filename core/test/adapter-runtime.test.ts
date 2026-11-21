import { describe, expect, it, vi } from 'vitest';
import { IpcDecoder, decodeAdapterJson, encodeAdapterJson, encodeIpcFrame } from '@voipgw/protocol';
import { AdapterRuntime, type AdapterRuntimeRepository } from '../src/channels/adapter-runtime.js';
import type { AdapterTransportHandlers, AdapterTransportSocket } from '../src/adapters/ipc-listener.js';

type Platform = 'qq' | 'telegram';
const frame = (type:string, payload:unknown, n:number) => encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type,id:'ipc_'+String(n).padStart(26,'0'),ts:1,payload})});
const read = (bytes:Uint8Array) => { const f=new IpcDecoder().push(bytes)[0]!; if(f.type!==1) throw Error(); return decodeAdapterJson(f.data); };
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
const hello=(platform:Platform,n=1)=>frame('adapter.hello',{platform,adapterVersion:'fake',protocol:1},n);
const state=(name:string|null,n:number,status='logged_in')=>frame('account.state',{state:status,selfId:name,alias:null,detail:null},n);
const capability=(n:number,login=true)=>frame('capabilities',{login,sendMessage:true,receiveMessage:true,dial:true,receiveAudio:true,sendAudio:true,maxConcurrentCalls:1},n);
function setup() {
  const rows:Record<Platform,{platform:Platform;state:string;selfId:string|null;capabilities:unknown}>={qq:{platform:'qq',state:'logged_in',selfId:null,capabilities:{}},telegram:{platform:'telegram',state:'logged_in',selfId:null,capabilities:{}}};
  const repo:AdapterRuntimeRepository={list:vi.fn(async()=>Object.values(rows).map(row=>({...row}))),adapterOffline:vi.fn(async (p:Platform)=>{rows[p].state='offline';rows[p].capabilities={};}),adapterState:vi.fn(async(p:Platform,s:{state:string;selfId:string|null;alias:string|null})=>{rows[p].state=s.state;rows[p].selfId=s.selfId;}),adapterCapabilities:vi.fn(async(p:Platform,c:unknown)=>{rows[p].capabilities=c;})};
  const connections=new Map<string,(socket:AdapterTransportSocket)=>AdapterTransportHandlers>();
  const publish=vi.fn(async(_type:string,_data:unknown)=>{});
  const runtime=new AdapterRuntime({repository:repo,publish,adapters:{qq:{enabled:true,socket:'qq'},telegram:{enabled:true,socket:'telegram'}},listenerFactory:({path,onConnection})=>{connections.set(path,onConnection);return {start:async()=>{},close:async()=>{}};}});
  const peer=(platform:Platform)=>{const writes:Uint8Array[]=[];const socket={write:(data:Uint8Array)=>writes.push(data),destroy:vi.fn()};return {writes,connection:connections.get(platform)!(socket),socket};};
  return {runtime,repo,publish,rows,peer};
}
describe('adapter lifecycle cleanup',()=>{
  const makeRuntime=(listeners: {start:()=>Promise<void>;close:()=>Promise<void>}[])=>{
    const repo:AdapterRuntimeRepository={list:vi.fn(async()=>[]),adapterOffline:vi.fn(async()=>{}),adapterState:vi.fn(async()=>{}),adapterCapabilities:vi.fn(async()=>{})};
    let index=0;
    return {repo,runtime:new AdapterRuntime({repository:repo,publish:vi.fn(async()=>{}),adapters:{qq:{enabled:true,socket:'qq'},telegram:{enabled:true,socket:'telegram'}},listenerFactory:()=>listeners[index++]!})};
  };
  it('retains startup and rollback failures, and shutdown reports uncertainty',async()=>{
    const startup=new Error('start failed'); const rollback=new Error('rollback failed'); const failedStartCleanup=new Error('failed start cleanup');
    const first={start:vi.fn(async()=>{}),close:vi.fn(async()=>{throw rollback;})};
    const second={start:vi.fn(async()=>{throw startup;}),close:vi.fn(async()=>{throw failedStartCleanup;})};
    const {runtime}=makeRuntime([first,second]);
    const failure=await runtime.start().catch(error=>error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual([startup,failedStartCleanup,rollback]);
    const closing=await runtime.close().catch(error=>error);
    expect(closing).toBeInstanceOf(AggregateError); expect(closing.errors).toEqual([failure,rollback,failedStartCleanup]);
    expect(first.close).toHaveBeenCalledTimes(2); expect(second.close).toHaveBeenCalledTimes(2);
  });
  it('waits for every startup reconciliation write after a failure',async()=>{
    const listeners=[{start:vi.fn(async()=>{}),close:vi.fn(async()=>{})},{start:vi.fn(async()=>{}),close:vi.fn(async()=>{})}];
    const {runtime,repo}=makeRuntime(listeners); const failure=new Error('offline write failed');
    let release!:()=>void; const gate=new Promise<void>(resolve=>release=resolve);
    repo.adapterOffline=vi.fn(async platform=>{if(platform==='qq') throw failure; await gate;});
    const start=runtime.start(); let settled=false; void start.catch(()=>{}).then(()=>{settled=true;});
    await tick(); expect(settled).toBe(false); release();
    const error=await start.catch(reason=>reason); expect(error.errors).toEqual([failure]);
    expect(listeners.every(listener=>listener.start.mock.calls.length===0)).toBe(true);
    await expect(runtime.close()).rejects.toBeInstanceOf(AggregateError);
  });
  it('surfaces disconnect persistence errors while draining both sessions',async()=>{
    const listeners=[{start:vi.fn(async()=>{}),close:vi.fn(async()=>{})},{start:vi.fn(async()=>{}),close:vi.fn(async()=>{})}];
    const {runtime,repo}=makeRuntime(listeners); await runtime.start();
    const socketFailure=new Error('destroy failed'); const persistenceFailure=new Error('offline failed');
    const first={write:vi.fn(),destroy:vi.fn(()=>{throw socketFailure;})}; const second={write:vi.fn(),destroy:vi.fn()};
    runtime.manager.attach('qq',first); runtime.manager.attach('telegram',second); await tick();
    repo.adapterOffline=vi.fn(async p=>{if(p==='qq') throw persistenceFailure;});
    const error=await runtime.close().catch(reason=>reason);
    expect(error).toBeInstanceOf(AggregateError); expect(error.errors).toContain(persistenceFailure);
    expect(error.errors.some((item:unknown)=>item instanceof AggregateError && item.errors.includes(socketFailure))).toBe(true);
    expect(second.destroy).toHaveBeenCalledOnce(); expect(runtime.manager.status('telegram')).toBe('offline');
  });
  it('drains every listener and manager even when multiple closes fail',async()=>{
    const errors=[new Error('first close'),new Error('second close')];
    const listeners=errors.map(error=>({start:vi.fn(async()=>{}),close:vi.fn(async()=>{throw error;})}));
    const {runtime,repo}=makeRuntime(listeners); await runtime.start();
    let release!:()=>void; let entered!:()=>void;
    const gate=new Promise<void>(resolve=>release=resolve); const started=new Promise<void>(resolve=>entered=resolve);
    repo.adapterOffline=vi.fn(async()=>{entered();await gate;});
    const socket={write:vi.fn(),destroy:vi.fn()}; runtime.manager.attach('qq',socket); await started;
    const firstClose=runtime.close(); expect(runtime.close()).toBe(firstClose);
    let settled=false; void firstClose.catch(()=>{}).then(()=>{settled=true;}); await tick(); expect(settled).toBe(false);
    release(); const failure=await firstClose.catch(error=>error);
    expect(failure).toBeInstanceOf(AggregateError); expect(failure.errors).toEqual(errors);
    expect(listeners.every(listener=>listener.close.mock.calls.length===1)).toBe(true);
    expect(socket.destroy).toHaveBeenCalledOnce(); expect(runtime.manager.status('qq')).toBe('offline');
    await expect(runtime.start()).rejects.toThrow('runtime unavailable');
  });
});

describe('adapter integration',()=>{
  it('persists reports, emits admin events, rejects unsupported events and records disconnect',async()=>{
    const {runtime,rows,peer,publish}=setup(); await runtime.start(); expect(rows.qq.state).toBe('offline');
    const a=peer('qq');a.connection.data(hello('qq'));a.connection.data(capability(2)); await tick();
    expect(runtime.manager.status('qq')).toBe('unknown'); expect(rows.qq.capabilities).toEqual({});
    a.connection.data(state(null,3,'login_pending'));a.connection.data(frame('login.step',{step:'code',qrPngBase64:null,hint:'enter code'},4));
    a.connection.data(frame('message.received',{platformMessageId:'m',senderId:'u',senderName:null,chatType:'private',forwarded:false,isContact:true,text:'test',ts:1},5));await tick();
    expect(rows.qq).toMatchObject({state:'login_pending',selfId:null,capabilities:{login:true,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0}});
    expect(publish).toHaveBeenCalledWith('channel.login.step',{platform:'qq',step:'code',qrPngBase64:null,hint:'enter code'});
    expect(read(a.writes[4]!).payload).toEqual({refId:'ipc_'+String(5).padStart(26,'0'),ok:false,error:'CAPABILITY_UNSUPPORTED'});
    expect(runtime.manager.loginStep('qq')).toEqual({step:'code',qrPngBase64:null,hint:'enter code'});
    a.connection.close();await tick();expect(rows.qq.state).toBe('offline');expect(runtime.manager.loginStep('qq')).toBeNull();await runtime.close();
  });
  it('rejects new attachments and starts as soon as shutdown begins',async()=>{
    const {runtime,peer}=setup(); await runtime.start(); const active=peer('qq'); active.connection.data(hello('qq')); await tick();
    const closing=runtime.close(); const socket={write:vi.fn(),destroy:vi.fn()};
    expect(()=>runtime.manager.attach('qq',socket)).toThrow('manager closed'); expect(socket.destroy).toHaveBeenCalledOnce();
    await expect(runtime.start()).rejects.toThrow('runtime unavailable'); await closing;
  });
  it('serializes a replacement behind old in-flight writes and fences old publication',async()=>{
    const {runtime,repo,rows,peer,publish}=setup();await runtime.start();let release!:()=>void;let entered!:()=>void;
    const enteredPromise=new Promise<void>(r=>entered=r);const gate=new Promise<void>(r=>release=r);
    const original=repo.adapterState;repo.adapterState=vi.fn(async(p,s)=>{if(s.selfId==='old'){entered();await gate;}await original(p,s);});
    const old=peer('qq');old.connection.data(hello('qq'));old.connection.data(capability(2));old.connection.data(state('old',3));await enteredPromise;
    const replacement=peer('qq');replacement.connection.data(hello('qq',4));replacement.connection.data(capability(5));replacement.connection.data(state('new',6));
    const other=peer('telegram');other.connection.data(hello('telegram',7));other.connection.data(capability(8));other.connection.data(state('other',9));await tick();expect(rows.telegram.selfId).toBe('other');
    release();await tick();await tick();expect(rows.qq.selfId).toBe('new');expect(rows.qq.state).toBe('logged_in');
    expect(publish.mock.calls.some(([type,data])=>type==='channel.updated'&&(data as {selfId?:string;state?:string}).selfId==='old'&&(data as {state?:string}).state==='logged_in')).toBe(false);
    old.connection.close();await tick();expect(rows.qq.state).toBe('logged_in');await runtime.close();
  });
});
