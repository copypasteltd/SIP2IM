import { expect, it, vi } from 'vitest';
import { encodeAdapterJson, encodeIpcFrame } from '@voipgw/protocol';
import { AdapterManager } from '../src/channels/adapter-manager.js';
import { createServer, type HttpDeps } from '../src/http/server.js';

it('reports observed IPC health and unknown without an observer', async () => {
  const manager = new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}});
  const deps = {health:async()=>true,adapterHealth:()=>({qq:manager.status('qq'),telegram:manager.status('telegram')})} as HttpDeps;
  const app=createServer(deps), fallback=createServer({health:async()=>false} as HttpDeps);
  const get=async()=> (await app.inject({url:'/api/health'})).json().data;
  try {
    expect((await fallback.inject({url:'/api/health'})).json().data).toEqual({ok:false,db:'error',adapters:{qq:'unknown',telegram:'unknown'}});
    expect((await get()).adapters).toEqual({qq:'offline',telegram:'offline'});
    const connection=manager.attach('qq',{write:vi.fn(),destroy:vi.fn()});
    expect((await get()).adapters.qq).toBe('unknown');
    connection.data(encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type:'adapter.hello',id:'ipc_00000000000000000000000001',ts:1,payload:{platform:'qq',adapterVersion:'fake',protocol:1}})}));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect((await get()).adapters.qq).toBe('unknown');
    const report = (type:string,payload:unknown,n:number) => encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type,id:'ipc_'+String(n).padStart(26,'0'),ts:1,payload})});
    connection.data(report('capabilities',{login:false,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0},2));
    await new Promise(resolve=>setTimeout(resolve,0)); expect((await get()).adapters.qq).toBe('unknown');
    connection.data(report('account.state',{state:'offline',selfId:null,alias:null,detail:null},3));
    await new Promise(resolve=>setTimeout(resolve,0));
    expect((await get()).adapters).toEqual({qq:'online',telegram:'offline'});
    connection.close(); expect((await get()).adapters.qq).toBe('offline');
  } finally { manager.close(); await app.close(); await fallback.close(); }
});
