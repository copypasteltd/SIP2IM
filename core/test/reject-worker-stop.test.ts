import type pg from 'pg';
import {expect,it,vi} from 'vitest';
import {RejectIntentWorker} from '../src/calls/device-events.js';
import {identityConflictEvent, identityEvent, type RejectTarget} from '../src/calls/generation.js';

function deferred<T>() {
  let resolve!:(value:T)=>void;
  const promise=new Promise<T>(r=>{resolve=r;});
  return {promise,resolve};
}

const generation='gen_'+'1'.repeat(26);
const callId='cal_'+'1'.repeat(26);
const connectionId='12345678-1234-4321-8123-123456789012';
const rows=[{session_id:'s1',device_id:'device',call_id:callId,generation,connection_id:connectionId},
  {session_id:'s2',device_id:'device',call_id:'cal_'+'2'.repeat(26),generation:'gen_'+'2'.repeat(26),connection_id:connectionId}];

function fixture(options:{
  claimGate?:Promise<void>; validGate?:Promise<void>; persistGate?:Promise<void>; scanGate?:Promise<void>;
  invalid?:'claim'|'validation'; rows?:unknown[]; claimCommitUnknown?:boolean; leaseExpired?:boolean;
} = {}) {
  const claimReached=deferred<void>(),validReached=deferred<void>(),persistReached=deferred<void>(),scanReached=deferred<void>();
  const transaction=vi.fn(async(sql:string,args:unknown[]=[])=>{
    if(sql.startsWith('SELECT id FROM device')||sql.startsWith('SELECT id FROM call_session'))return {rowCount:1,rows:[{}]};
    if(sql.startsWith('SELECT 1 FROM call_reject_intent'))return {rowCount:1,rows:options.invalid==='claim'?[]:[{}]};
    if(sql.includes("SET state='sending'")){claimReached.resolve();await options.claimGate;return {rowCount:1,rows:[{}]};}
    if(sql.includes('SET state=CASE WHEN')){
      persistReached.resolve(); await options.persistGate;
      return {rowCount:1,rows:[{state:options.leaseExpired?'unknown':args[1]}]};
    }
    if(sql.startsWith('UPDATE call_session'))return {rowCount:1,rows:[{}]};
    if(sql==='COMMIT'&&options.claimCommitUnknown)throw new Error('lost COMMIT reply');
    return {rowCount:0,rows:[],command:sql};
  });
  let scans=0;
  const poolQuery=vi.fn(async(sql:string,_args:unknown[]=[])=>{
    if(sql.startsWith('SELECT session_id FROM'))return {rows:[]};
    if(sql.startsWith('SELECT i.session_id')){scans++;scanReached.resolve();await options.scanGate;return {rows:options.rows??rows};}
    if(!sql.startsWith('SELECT 1 FROM call_reject_intent'))throw new Error('Unexpected query');
    validReached.resolve();await options.validGate;return {rowCount:1,rows:options.invalid==='validation'?[]:[{}]};
  });
  const pool={connect:async()=>({query:transaction,release:vi.fn()}),query:poolQuery} as unknown as pg.Pool;
  return {pool,transaction,poolQuery,claimReached,validReached,persistReached,scanReached,scans:()=>scans};
}

it('has no outgoing actions by default and ignores legacy tuples even if a port is supplied',async()=>{
  const defaultWorker=fixture();
  await new RejectIntentWorker(defaultWorker.pool).flush();
  expect(defaultWorker.scans()).toBe(0);
  expect(defaultWorker.transaction).not.toHaveBeenCalled();
  const legacy=fixture({rows:[{session_id:'s1',device_id:'device',call_id:callId}]});
  const prepareReject=vi.fn();
  await new RejectIntentWorker(legacy.pool,{prepareReject}).flush();
  expect(prepareReject).not.toHaveBeenCalled();
  expect(legacy.transaction).not.toHaveBeenCalled();
});

it('stops during a claim without sending or rolling it back to pending',async()=>{
  const gate=deferred<void>();const f=fixture({claimGate:gate.promise});const prepareReject=vi.fn();
  const worker=new RejectIntentWorker(f.pool,{prepareReject});const flush=worker.flush();
  await f.claimReached.promise;const stop=worker.stop();gate.resolve();await Promise.all([flush,stop]);
  expect(prepareReject).not.toHaveBeenCalled();
  expect(f.transaction.mock.calls.some(([sql])=>sql==='COMMIT')).toBe(true);
  expect(f.transaction.mock.calls.some(([sql])=>sql.includes("SET state='pending'"))).toBe(false);
});

it('stops after a claim while validation is unresolved',async()=>{
  const gate=deferred<void>();const f=fixture({validGate:gate.promise});const prepareReject=vi.fn();
  const worker=new RejectIntentWorker(f.pool,{prepareReject});const flush=worker.flush();
  await f.validReached.promise;const stop=worker.stop();gate.resolve();await Promise.all([flush,stop]);
  expect(prepareReject).not.toHaveBeenCalled();
});

it('waits for an admitted send and outcome write and does not send the next row',async()=>{
  const result=deferred<{ok:boolean;error:string|null}>(),persist=deferred<void>();
  const f=fixture({persistGate:persist.promise});const send=vi.fn(()=>result.promise);const prepareReject=vi.fn(()=>send);
  const worker=new RejectIntentWorker(f.pool,{prepareReject});const flush=worker.flush();
  await vi.waitFor(()=>expect(send).toHaveBeenCalledTimes(1));
  expect(prepareReject).toHaveBeenCalledExactlyOnceWith({deviceId:'device',callId,generation,connectionId});
  let stopped=false;const stop=worker.stop().then(()=>{stopped=true;});
  await worker.flush();await Promise.resolve();expect(stopped).toBe(false);
  result.resolve({ok:true,error:null});await f.persistReached.promise;expect(stopped).toBe(false);
  persist.resolve();await Promise.all([flush,stop,worker.stop()]);
  expect(send).toHaveBeenCalledTimes(1);expect(stopped).toBe(true);
  expect(f.transaction.mock.calls.find(([sql])=>sql.includes('SET state=CASE WHEN'))?.[1]).toEqual(['s1','accepted']);
  expect(f.transaction.mock.calls.some(([sql])=>sql.startsWith('UPDATE call_session'))).toBe(false);
});

it.each([false,true])('coalesces flush requests during a scan and respects stop=%s',async stopEarly=>{
  const gate=deferred<void>();const f=fixture({scanGate:gate.promise,rows:[]});
  const worker=new RejectIntentWorker(f.pool,{prepareReject:vi.fn()});const first=worker.flush();
  await f.scanReached.promise;const second=worker.flush(),third=worker.flush();
  const stop=stopEarly?worker.stop():undefined;gate.resolve();await Promise.all([first,second,third,stop]);
  expect(f.scans()).toBe(stopEarly?1:2);
});

it('stops before scheduled work starts and remains stopped',async()=>{
  const f=fixture();const prepareReject=vi.fn();const worker=new RejectIntentWorker(f.pool,{prepareReject});
  const flush=worker.flush();await Promise.all([worker.stop(),flush]);await worker.flush();
  expect(prepareReject).not.toHaveBeenCalled();expect(f.poolQuery).not.toHaveBeenCalled();
});

it.each(['claim','validation'] as const)('checks exact identity and quarantine at %s before preparing egress',async stage=>{
  const f=fixture({invalid:stage,rows:[rows[0]]});const prepareReject=vi.fn();
  await new RejectIntentWorker(f.pool,{prepareReject}).flush();
  expect(prepareReject).not.toHaveBeenCalled();
  const result=(stage==='claim'?f.transaction:f.poolQuery).mock.calls.find(([sql])=>sql.startsWith('SELECT 1 FROM call_reject_intent'));
  expect(result?.[0]).toContain('q.event=$3');
  expect(result?.[1]).toEqual([stage==='claim'?'pending':'sending',identityEvent,identityConflictEvent,'s1','device',callId,generation,connectionId]);
});

it('does not let a positive ACK arriving after the lease advance the session',async()=>{
  const f=fixture({leaseExpired:true,rows:[rows[0]]});
  const send=vi.fn(async()=>({ok:true,error:null}));
  await new RejectIntentWorker(f.pool,{prepareReject:()=>send}).flush();
  const update=f.transaction.mock.calls.find(([sql])=>sql.includes('SET state=CASE WHEN'));
  expect(update?.[0]).toContain('lease_until>clock_timestamp() AND expires_at>clock_timestamp()');
  expect(update?.[1]).toEqual(['s1','accepted']);
  expect(f.transaction.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_session'))?.[1]?.slice(1)).toEqual(['rejecting','unknown','unknown']);
});

it('does not prepare a send when the durable claim commit outcome is unknown',async()=>{
  const f=fixture({claimCommitUnknown:true,rows:[rows[0]]});const prepareReject=vi.fn();
  await expect(new RejectIntentWorker(f.pool,{prepareReject}).flush()).rejects.toThrow('Transaction COMMIT outcome is uncertain');
  expect(prepareReject).not.toHaveBeenCalled();
});

it.each(['replaced','CAPABILITY_UNSUPPORTED','CALL_NOT_RINGING','timeout'] as const)('retains unknown and no terminal projection on %s',async outcome=>{
  const f=fixture({rows:[rows[0]]});
  const send=vi.fn(async()=>{
    if(outcome==='timeout')throw new Error('timeout');
    return {ok:false,error:outcome};
  });
  const prepareReject=vi.fn((target:RejectTarget)=>outcome==='replaced'&&target.connectionId===connectionId?null:send);
  await new RejectIntentWorker(f.pool,{prepareReject}).flush();
  expect(prepareReject).toHaveBeenCalledExactlyOnceWith({deviceId:'device',callId,generation,connectionId});
  expect(send).toHaveBeenCalledTimes(outcome==='replaced'?0:1);
  expect(f.transaction.mock.calls.find(([sql])=>sql.includes('SET state=CASE WHEN'))?.[1]).toEqual(['s1','unknown']);
  expect(f.transaction.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_session'))?.[1]?.slice(1,3)).toEqual(['rejecting','unknown']);
});
