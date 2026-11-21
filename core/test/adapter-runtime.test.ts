import { describe, expect, it, vi } from 'vitest';
import { IpcDecoder, decodeAdapterJson, encodeAdapterJson, encodeIpcFrame } from '@voipgw/protocol';
import { AdapterRuntime, type AdapterRuntimeOptions, type AdapterRuntimeRepository } from '../src/channels/adapter-runtime.js';
import type { AdapterTransportHandlers, AdapterTransportSocket } from '../src/adapters/ipc-listener.js';

type Platform = 'qq' | 'telegram';
const frame = (type:string, payload:unknown, n:number) => encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type,id:'ipc_'+String(n).padStart(26,'0'),ts:1,payload})});
const read = (bytes:Uint8Array) => { const f=new IpcDecoder().push(bytes)[0]!; if(f.type!==1) throw Error(); return decodeAdapterJson(f.data); };
const tick = () => new Promise(resolve=>setTimeout(resolve,0));
const hello=(platform:Platform,n=1)=>frame('adapter.hello',{platform,adapterVersion:'fake',protocol:1},n);
const state=(name:string|null,n:number,status='logged_in')=>frame('account.state',{state:status,selfId:name,alias:null,detail:null},n);
const capability=(n:number,login=true)=>frame('capabilities',{login,sendMessage:true,receiveMessage:true,dial:true,receiveAudio:true,sendAudio:true,maxConcurrentCalls:1},n);
const effective=(login:boolean)=>({login,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0});
const positive=(n:number)=>({refId:'ipc_'+String(n).padStart(26,'0'),ok:true,error:null});
const loginStep=(n:number,step='code')=>frame('login.step',{step,qrPngBase64:null,hint:null},n);
const acks=(peer:{writes:Uint8Array[]})=>peer.writes.map(bytes=>read(bytes).payload);
const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>resolve=r);return{resolve,promise};};
const bootstrap=(peer:{connection:AdapterTransportHandlers},platform:Platform,name:string|null,login=true,status='logged_in')=>{
  peer.connection.data(hello(platform));peer.connection.data(capability(2,login));peer.connection.data(state(name,3,status));
};
function setup(options: Pick<AdapterRuntimeOptions,'stopping'|'ownsDatabase'> = {}) {
  const rows:Record<Platform,{platform:Platform;state:string;selfId:string|null;capabilities:unknown}>={qq:{platform:'qq',state:'logged_in',selfId:null,capabilities:{}},telegram:{platform:'telegram',state:'logged_in',selfId:null,capabilities:{}}};
  const repo:AdapterRuntimeRepository={
    list:vi.fn(async()=>Object.values(rows).map(row=>({...row}))),
    adapterOffline:vi.fn<AdapterRuntimeRepository['adapterOffline']>(async(p,opts)=>{
      if (opts?.isCurrent && !opts.isCurrent()) return;
      rows[p].state='offline';rows[p].capabilities={};
    }),
    adapterState:vi.fn<AdapterRuntimeRepository['adapterState']>(async(p,s,opts)=>{
      if (opts?.isCurrent && !opts.isCurrent()) return;
      rows[p].state=s.state;rows[p].selfId=s.selfId;
      if (opts?.initialLoginSupport !== undefined) rows[p].capabilities=effective(opts.initialLoginSupport);
    }),
    adapterCapabilities:vi.fn<AdapterRuntimeRepository['adapterCapabilities']>(async(p,c,opts)=>{
      if (opts?.isCurrent && !opts.isCurrent()) return;
      rows[p].capabilities=effective((c as {login:boolean}).login);
    }),
  };
  const connections=new Map<string,(socket:AdapterTransportSocket)=>AdapterTransportHandlers>();
  const publish=vi.fn<AdapterRuntimeOptions['publish']>(async()=>{});
  const listeners:Array<{start:ReturnType<typeof vi.fn>;close:ReturnType<typeof vi.fn>}>=[];
  const runtime=new AdapterRuntime({repository:repo,publish,...options,adapters:{qq:{enabled:true,socket:'qq'},telegram:{enabled:true,socket:'telegram'}},listenerFactory:({path,onConnection})=>{
    connections.set(path,onConnection);
    const listener={start:vi.fn(async()=>{}),close:vi.fn(async()=>{})};listeners.push(listener);return listener;
  }});
  const peer=(platform:Platform)=>{const writes:Uint8Array[]=[];const socket={write:(data:Uint8Array)=>writes.push(data),destroy:vi.fn()};return {writes,connection:connections.get(platform)!(socket),socket};};
  return {runtime,repo,publish,rows,peer,listeners};
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
    const challenge=runtime.manager.loginStep('qq')!;
    expect(challenge).toEqual({step:'code',qrPngBase64:null,hint:'enter code',challengeId:expect.any(String)});
    expect(publish).toHaveBeenCalledWith('channel.login.step',{platform:'qq',...challenge},expect.any(Function));
    expect(read(a.writes[4]!).payload).toEqual({refId:'ipc_'+String(5).padStart(26,'0'),ok:false,error:'CAPABILITY_UNSUPPORTED'});
    a.connection.close();await tick();expect(rows.qq.state).toBe('offline');expect(runtime.manager.loginStep('qq')).toBeNull();await runtime.close();
  });
  it('separates startup reconciliation, attachment reset and observed disconnect',async()=>{
    const {runtime,repo,peer,publish}=setup();
    const offline=vi.mocked(repo.adapterOffline);
    await runtime.start();
    expect(offline).toHaveBeenCalledWith('qq',{observeOutage:'persisted-login',isCurrent:expect.any(Function)});
    const a=peer('qq');a.connection.data(hello('qq'));a.connection.data(capability(2));
    a.connection.data(state('fixture',3));await tick();
    expect(offline).toHaveBeenCalledWith('qq',{observeOutage:false,isCurrent:expect.any(Function)});
    offline.mockResolvedValueOnce({type:'alert.raised',data:{id:'fixture'}});
    a.connection.close();await tick();
    expect(offline).toHaveBeenCalledWith('qq',{observeOutage:true,isCurrent:expect.any(Function)});
    expect(publish).toHaveBeenCalledWith('alert.raised',{id:'fixture'},expect.any(Function));
    await runtime.close();
  });
  it.each([true, false])('waits for the single committed bootstrap before the final ACK (login=%s)',async login=>{
    const {runtime,repo,rows,peer}=setup(); await runtime.start();
    const original=repo.adapterState;
    const entered=deferred<void>(), commit=deferred<void>();
    repo.adapterState=vi.fn(async (platform,report,options)=>{
      if (report.selfId === 'first') {
        expect(options?.initialLoginSupport).toBe(login);
        entered.resolve(); await commit.promise;
      }
      return original(platform,report,options);
    });
    const client=peer('qq');bootstrap(client,'qq','first',login);
    try {
      await entered.promise;
      expect(acks(client)).toEqual([positive(1),positive(2)]);
      expect(runtime.manager.status('qq')).toBe('unknown');
      expect(rows.qq).toMatchObject({state:'offline',capabilities:{}});
      expect(repo.adapterCapabilities).not.toHaveBeenCalled();
      commit.resolve(); await tick();
      expect(acks(client)).toEqual([positive(1),positive(2),positive(3)]);
      expect(runtime.manager.status('qq')).toBe('online');
      expect(rows.qq).toMatchObject({state:'logged_in',selfId:'first',capabilities:effective(login)});
      client.connection.data(state('second',4));
      await tick();
      expect(repo.adapterState).toHaveBeenLastCalledWith('qq',expect.objectContaining({ selfId:'second' }),{isCurrent:expect.any(Function)});
      expect(rows.qq.capabilities).toEqual(effective(login));
      client.connection.data(capability(5,!login)); await tick();
      expect(repo.adapterCapabilities).toHaveBeenCalledExactlyOnceWith('qq',{login:!login},{isCurrent:expect.any(Function)});
      expect(acks(client)).toEqual([1,2,3,4,5].map(positive));
      expect(rows.qq.capabilities).toEqual(effective(!login));
    } finally { commit.resolve(); await runtime.close(); }
  });

  it('does not ACK a failed bootstrap as ready or publish the failed report',async()=>{
    const {runtime,repo,publish,rows,peer}=setup(); await runtime.start();
    vi.mocked(repo.adapterState).mockRejectedValueOnce(new Error('bootstrap commit not confirmed'));
    const client=peer('qq'); bootstrap(client,'qq','failed'); await tick();
    try {
      expect(acks(client)).toEqual([positive(1),positive(2),{...positive(3),ok:false,error:'INTERNAL'}]);
      expect(client.socket.destroy).toHaveBeenCalledOnce();
      expect(runtime.manager.status('qq')).toBe('offline');
      expect(repo.adapterCapabilities).not.toHaveBeenCalled();
      expect(rows.qq).toMatchObject({state:'offline',capabilities:{}});
      expect(publish.mock.calls.some(([,data])=>(data as {selfId?:string})?.selfId==='failed')).toBe(false);
    } finally { await runtime.close(); }
  });

  it('keeps report ACKs and confirmed login steps independent of failed readback or fanout',async()=>{
    const {runtime,repo,publish,peer}=setup(); await runtime.start();
    vi.mocked(repo.list).mockRejectedValueOnce(new Error('readback unavailable'));
    publish.mockRejectedValue(new Error('notification unavailable'));
    const client=peer('qq'); bootstrap(client,'qq',null,true,'login_pending');
    client.connection.data(loginStep(4));
    client.connection.data(capability(5));
    client.connection.data(state(null,6,'login_pending'));
    client.connection.data(loginStep(7,'password'));
    await tick();
    try {
      expect(acks(client)).toEqual([1,2,3,4,5,6,7].map(positive));
      expect(runtime.manager.status('qq')).toBe('online');
      expect(runtime.manager.loginStep('qq')).toEqual({step:'password',qrPngBase64:null,hint:null,challengeId:expect.any(String)});
      expect(client.socket.destroy).not.toHaveBeenCalled();
      expect(publish).toHaveBeenCalled();
    } finally { await runtime.close(); }
  });

  it('coalesces a backlog behind a slow publication without delaying reports for either platform',async()=>{
    const {runtime,repo,publish,rows,peer}=setup(); await runtime.start();
    const firstRead=deferred<void>(), releaseRead=deferred<void>();
    vi.mocked(repo.list).mockImplementationOnce(async()=>{firstRead.resolve(); await releaseRead.promise; return Object.values(rows);});
    const qq=peer('qq');bootstrap(qq,'qq','first');
    try {
      await firstRead.promise; await tick();
      expect(acks(qq)).toEqual([1,2,3].map(positive));
      for(let i=4;i<=11;i++) qq.connection.data(state('observed-'+i,i));
      const tg=peer('telegram');bootstrap(tg,'telegram','other');await tick();
      expect(acks(qq)).toEqual(Array.from({length:11},(_,i)=>positive(i+1)));
      expect(acks(tg)).toEqual([1,2,3].map(positive));
      expect(publish.mock.calls.some(([type,data])=>type==='channel.updated'&&(data as {platform:string}).platform==='qq')).toBe(false);
      releaseRead.resolve(); await tick();
      const notices=publish.mock.calls.filter(([type,data])=>type==='channel.updated'&&(data as {platform:string}).platform==='qq');
      expect(notices).toHaveLength(1);
      expect(notices[0]?.[1]).toMatchObject({selfId:'observed-11'});
    } finally { releaseRead.resolve(); await runtime.close(); }
  });

  it.each(['new step','new generation'] as const)('fences an in-flight prompt after a %s and preserves ACK ordering',async change=>{
    const {runtime,publish,peer}=setup(); await runtime.start();
    const first=peer('qq');bootstrap(first,'qq',null,true,'login_pending');
    await tick(); publish.mockClear();
    const entered=deferred<void>(), send=deferred<void>();
    const delivered:unknown[]=[];
    let firstNotice=true;
    publish.mockImplementation(async(type,data,current)=>{
      if(type!=='channel.login.step') return;
      if(firstNotice) {
        firstNotice=false;
        expect(acks(first)).toContainEqual(positive(4));
        entered.resolve(); await send.promise;
      }
      if(current()) delivered.push(data);
    });
    first.connection.data(loginStep(4));
    try {
      await entered.promise;
      const original=runtime.manager.loginStep('qq')!;
      const replacement=change==='new generation' ? peer('qq') : first;
      if(replacement!==first) {
        expect(runtime.manager.loginStep('qq')).toBeNull();
        bootstrap(replacement,'qq','new',true,'login_pending');
      }
      const report=change==='new generation' ? 4 : 5;
      replacement.connection.data(loginStep(report)); await tick();
      expect(acks(replacement)).toContainEqual(positive(report));
      const next=runtime.manager.loginStep('qq')!;
      expect(next.challengeId).not.toBe(original.challengeId);
      send.resolve(); await tick();
      expect(delivered).toEqual([{platform:'qq',...next}]);
    } finally { send.resolve(); await runtime.close(); }
  });

  it('starts no new listeners when Core stops during startup reconciliation',async()=>{
    const controller=new AbortController();
    const {runtime,repo,listeners}=setup({stopping:controller.signal});
    const entered=deferred<void>(), release=deferred<void>();
    vi.mocked(repo.adapterOffline).mockImplementation(async(_p,options)=>{
      entered.resolve(); await release.promise;
      expect(options?.isCurrent?.()).toBe(false);
    });
    const starting=runtime.start();
    try {
      await entered.promise; controller.abort();
      const socket={write:vi.fn(),destroy:vi.fn()};
      expect(()=>runtime.manager.attach('qq',socket)).toThrow('manager closed');
      expect(socket.destroy).toHaveBeenCalledOnce();
      release.resolve(); await starting;
      expect(listeners.every(l=>l.start.mock.calls.length===0)).toBe(true);
    } finally { release.resolve(); await runtime.close(); }
  });

  it('drains an already-started notification while closing admission synchronously',async()=>{
    const {runtime,repo,rows,peer,publish}=setup(); await runtime.start();
    const client=peer('qq'); bootstrap(client,'qq','ready'); await tick();
    const entered=deferred<void>(), release=deferred<void>();
    const delivered=vi.fn();
    publish.mockImplementationOnce(async(_type,_data,current)=>{
      entered.resolve(); await release.promise;
      if(current()) delivered();
    });
    client.connection.data(state('last',4));
    const closed=vi.fn();
    try {
      await entered.promise;
      const stopping=runtime.close().then(closed);
      await tick();
      expect(acks(client)).toContainEqual(positive(4));
      expect(closed).not.toHaveBeenCalled();
      expect(vi.mocked(repo.adapterOffline)).toHaveBeenLastCalledWith('qq',{observeOutage:false,isCurrent:expect.any(Function)});
      expect(rows.qq.state).toBe('offline');
      release.resolve(); await stopping; expect(closed).toHaveBeenCalledOnce();
      expect(delivered).not.toHaveBeenCalled();
    } finally { release.resolve(); await runtime.close(); }
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
    const original=repo.adapterState;repo.adapterState=vi.fn(async(p,s,opts)=>{if(s.selfId==='old'){entered();await gate;}await original(p,s,opts);});
    const old=peer('qq');old.connection.data(hello('qq'));old.connection.data(capability(2));old.connection.data(state('old',3));await enteredPromise;
    const replacement=peer('qq');replacement.connection.data(hello('qq',4));replacement.connection.data(capability(5));replacement.connection.data(state('new',6));
    const other=peer('telegram');other.connection.data(hello('telegram',7));other.connection.data(capability(8));other.connection.data(state('other',9));await tick();expect(rows.telegram.selfId).toBe('other');
    release();await tick();await tick();expect(rows.qq.selfId).toBe('new');expect(rows.qq.state).toBe('logged_in');
    expect(publish.mock.calls.some(([type,data])=>type==='channel.updated'&&(data as {selfId?:string;state?:string}).selfId==='old'&&(data as {state?:string}).state==='logged_in')).toBe(false);
    old.connection.close();await tick();expect(rows.qq.state).toBe('logged_in');await runtime.close();
  });
});
