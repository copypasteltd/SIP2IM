import type pg from 'pg';
import {expect,it,vi} from 'vitest';
import {persistCallDeviceEvent} from '../src/calls/device-events.js';
import {identityConflictEvent, identityEvent, recordCellularCallIdentity, type BoundCellularCall, type CallEventContext} from '../src/calls/generation.js';

const callId = 'cal_' + '1'.repeat(26);
const otherId = 'cal_' + '2'.repeat(26);
const generation = 'gen_' + '1'.repeat(26);
const nextGeneration = 'gen_' + '2'.repeat(26);
const originalConnection = '12345678-1234-4321-8123-123456789012';
const replacementConnection = '12345678-1234-4321-8123-123456789013';
const live: CallEventContext = {callGeneration:true, connectionId:originalConnection, isCurrent:()=>true};
const replacement = {...live, connectionId:replacementConnection};
const incoming = {id:'evt_incoming',type:'call.incoming',ts:1000,
  payload:{callId,generation,slot:null,subId:null,from:null,fromKind:'unknown'}};
const disconnected = {id:'evt_disconnected',type:'call.state',ts:1001,
  payload:{callId,generation,state:'disconnected',cause:'remote_hangup'}};
const active = {id:'evt_active',type:'call.state',ts:1001,payload:{callId,generation,state:'active',cause:null}};

function fixture(options: {fresh?: boolean; prior?: boolean; priorCollision?: boolean; matchingTerminal?: boolean; existing?: boolean; row?: BoundCellularCall} = {}) {
  const queries: {sql:string; args:unknown[]}[] = [];
  const result = (rows:unknown[]=[]) => ({rowCount:rows.length,rows});
  const query = vi.fn(async (sql:string,args:unknown[]=[]) => {
    queries.push({sql,args});
    if (sql.startsWith('SELECT id FROM device')) return result([{id:'device'}]);
    if (sql.startsWith('SELECT s.id,s.kind')) {
      const row = options.row;
      return result(row && args[0] === 'device' && args[1] === generation && args[2] === identityEvent ? [row] : []);
    }
    if (sql.startsWith('SELECT d.id,d.payload FROM device_event p')) {
      return result(options.matchingTerminal && args[2] === originalConnection && args[3] === callId && args[4] === generation ?
        [{id:disconnected.id,payload:disconnected.payload}] : []);
    }
    if (sql.startsWith("SELECT (d.payload->>'callId'")) return result(options.prior || options.priorCollision || options.matchingTerminal ? [{conflict:options.priorCollision === true}] : []);
    if (sql.startsWith('SELECT s.id FROM sim')) return result();
    if (sql.startsWith('SELECT s.device_id FROM call_session')) return result([{device_id:'device'}]);
    if (sql.startsWith('SELECT e.id FROM call_event')) return result(options.existing ? [{}] : []);
    if (sql.startsWith('SELECT $1::timestamptz BETWEEN')) return result([{fresh:options.fresh !== false}]);
    if (sql.startsWith('INSERT') || sql.startsWith('UPDATE')) return result([{}]);
    throw new Error('Unexpected statement: ' + sql);
  });
  return {client:{query} as unknown as pg.PoolClient, queries,
    statements:(prefix:string)=>queries.filter(q=>q.sql.startsWith(prefix))};
}

function bound(overrides:Partial<BoundCellularCall> = {}): BoundCellularCall {
  return {id:'session',kind:'platform_in',state:'unknown',leg_id:'leg',leg_state:'ringing',
    call_id:callId,connection_id:originalConnection,quarantined:false,...overrides};
}

it('records a negotiated incoming identity and history but cannot schedule rejection from hello alone',async()=>{
  const f=fixture();
  await persistCallDeviceEvent(f.client,'device',incoming,live);
  expect(f.statements('INSERT INTO call_session')[0]?.args.at(-1)).toBe('unknown');
  expect(f.statements('INSERT INTO call_leg')[0]?.args.at(-1)).toBe(callId);
  const mark=f.statements('INSERT INTO call_event').find(q=>q.args[3]===identityEvent);
  expect(JSON.parse(String(mark?.args[4]))).toEqual({callId,generation,connectionId:originalConnection});
  expect(f.statements('INSERT INTO call_reject_intent')).toHaveLength(0);
});

it('creates a generation-bound intent only for a fresh incoming call on an independently authorized connection',async()=>{
  const f=fixture();
  await persistCallDeviceEvent(f.client,'device',incoming,{...live,canReject:true});
  expect(f.statements('INSERT INTO call_session')[0]?.args.at(-1)).toBe('rejecting');
  const mark=f.queries.findIndex(q=>q.args[3]===identityEvent);
  const intent=f.queries.findIndex(q=>q.sql.startsWith('INSERT INTO call_reject_intent'));
  expect(mark).toBeGreaterThanOrEqual(0);
  expect(intent).toBeGreaterThan(mark);
  for(const options of [{fresh:false},{prior:true}]){
    const excluded=fixture(options);
    await persistCallDeviceEvent(excluded.client,'device',incoming,{...live,canReject:true});
    expect(excluded.statements('INSERT INTO call_session')[0]?.args.at(-1)).toBe('unknown');
    expect(excluded.statements('INSERT INTO call_reject_intent')).toHaveLength(0);
  }
});

it('never projects unnegotiated, missing, malformed, and stale generation evidence onto a call',async()=>{
  for(const [event,context] of [
    [disconnected,{...live,callGeneration:false}],
    [{...disconnected,payload:{callId,state:'disconnected',cause:'remote_hangup'}},live],
    [{...disconnected,payload:{...disconnected.payload,generation:'gen_bad'}},live],
    [disconnected,{...live,isCurrent:()=>false}],
  ] as const){
    const f=fixture({row:bound()});
    await persistCallDeviceEvent(f.client,'device',event,context);
    expect(f.statements('INSERT')).toHaveLength(0);
    expect(f.statements('UPDATE')).toHaveLength(0);
  }
});

it('quarantines reuse of a generation and keeps a new generation on the same callId separate',async()=>{
  const reused=fixture({row:bound({state:'rejecting'})});
  await persistCallDeviceEvent(reused.client,'device',{...incoming,payload:{...incoming.payload,callId:otherId}},live);
  expect(reused.statements('INSERT INTO call_event')[0]?.args[3]).toBe(identityConflictEvent);
  expect(reused.statements('UPDATE call_reject_intent')[0]?.args).toEqual(['session']);
  expect(reused.statements('UPDATE call_session')[0]?.args.slice(0,3)).toEqual(['session','rejecting','unknown']);
  const alreadyQuarantined=fixture({row:bound({quarantined:true})});
  await persistCallDeviceEvent(alreadyQuarantined.client,'device',disconnected,live);
  expect(alreadyQuarantined.statements('UPDATE')).toHaveLength(0);
  const distinct=fixture({row:bound()});
  await persistCallDeviceEvent(distinct.client,'device',{...incoming,payload:{...incoming.payload,generation:nextGeneration}},live);
  expect(distinct.statements('INSERT INTO call_session')).toHaveLength(1);
  expect(distinct.statements('UPDATE')).toHaveLength(0);
});

it('persists a negotiated orphan terminal and replays it only with exact identity and connection provenance',async()=>{
  const orphan=fixture();
  await persistCallDeviceEvent(orphan.client,'device',disconnected,live);
  expect(orphan.statements('INSERT INTO device_event')[0]?.args.slice(1,4)).toEqual(['device','core:cellular.state-admission.v1',
    JSON.stringify({sourceEventId:disconnected.id,connectionId:originalConnection})]);
  expect(orphan.statements('INSERT INTO call_event')).toHaveLength(0);
  const reordered=fixture({matchingTerminal:true});
  await persistCallDeviceEvent(reordered.client,'device',incoming,{...live,canReject:true});
  expect(reordered.statements('UPDATE call_session')[0]?.args.slice(1)).toEqual(['unknown','ended','remote_hangup']);
  expect(reordered.statements('INSERT INTO call_reject_intent')).toHaveLength(0);
  const changedConnection=fixture({matchingTerminal:true});
  await persistCallDeviceEvent(changedConnection.client,'device',incoming,{...replacement,canReject:true});
  expect(changedConnection.statements('UPDATE call_session')).toHaveLength(0);
  expect(changedConnection.statements('INSERT INTO call_reject_intent')).toHaveLength(0);
  const ambiguous=fixture({matchingTerminal:true,priorCollision:true});
  await persistCallDeviceEvent(ambiguous.client,'device',incoming,{...live,canReject:true});
  expect(ambiguous.statements('INSERT INTO call_event').some(q=>q.args[3]===identityConflictEvent)).toBe(true);
  expect(ambiguous.statements('UPDATE call_session')).toHaveLength(0);
  expect(ambiguous.statements('INSERT INTO call_reject_intent')).toHaveLength(0);
});

it('retains current cellular active evidence, leaves bridging to the media coordinator, and accepts a later exact terminal',async()=>{
  const row=bound({kind:'web_out',state:'cell_dialing',leg_state:'dialing'});
  const stale=fixture({row});
  await persistCallDeviceEvent(stale.client,'device',active,replacement);
  expect(stale.statements('UPDATE call_leg')).toHaveLength(0);
  const current=fixture({row});
  await persistCallDeviceEvent(current.client,'device',active,live);
  expect(current.statements('UPDATE call_leg')[0]?.args.slice(0,2)).toEqual(['leg','active']);
  expect(current.statements('UPDATE call_session')).toHaveLength(0);
  const end=fixture({row});
  await persistCallDeviceEvent(end.client,'device',disconnected,replacement);
  expect(end.statements('UPDATE call_session')[0]?.args.slice(0,3)).toEqual(['session','cell_dialing','ended']);
});

it('records matching terminal evidence on the unsettled leg of an ended session',async()=>{
  const row=bound({kind:'web_out',state:'ended',leg_state:'active'});
  const f=fixture({row});
  await persistCallDeviceEvent(f.client,'device',disconnected,replacement);
  expect(f.statements('UPDATE call_leg')[0]?.args).toEqual(['leg','disconnected','remote_hangup']);
  expect(f.statements('UPDATE call_session')).toHaveLength(0);
  const alreadyEnded=fixture({row:{...row,leg_state:'disconnected'}});
  await persistCallDeviceEvent(alreadyEnded.client,'device',active,live);
  expect(alreadyEnded.statements('UPDATE')).toHaveLength(0);
});

it('refuses a second durable generation assignment before inserting an identity marker',async()=>{
  const f=fixture({existing:true});
  await expect(recordCellularCallIdentity(f.client,{sessionId:'ses_'+'1'.repeat(26),legId:'leg_'+'1'.repeat(26),callId,generation,
    connectionId:originalConnection})).rejects.toThrow('CALL_IDENTITY_ALREADY_BOUND');
  expect(f.statements('SELECT e.id FROM call_event')[0]?.args.slice(-2)).toEqual(['device',generation]);
  expect(f.statements('INSERT')).toHaveLength(0);
});
