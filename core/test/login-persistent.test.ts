import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import Fastify from 'fastify';
import { IpcDecoder, decodeAdapterJson, encodeAdapterJson, encodeIpcFrame } from '@voipgw/protocol';
import { registerChannelControlRoutes } from '../src/channels/control-routes.js';
import { AdapterAdmissionRejected, AdapterManager, type AdapterLoginDispatch, type AdapterLoginTransport } from '../src/channels/adapter-manager.js';
import { LoginOperationRepository, PersistentLoginOperations } from '../src/channels/login-persistent.js';

type Row = { token: string; outcome: string | null };
function fakeDatabase() {
  const rows = new Map<string, Row>();
  const audit: {platform: string; token: string; outcome: string; actor: string}[] = [];
  let loseReleaseReply = false;
  let failAudit = false;
  let loseUpdateReply = false;
  let failUpdate = false;
  let terminalEvidence = false;
  const query = vi.fn(async (sql: string, args: string[]) => {
    const [platform, token, outcome] = args as [string, string, string];
    if (sql.startsWith('WITH released AS')) {
      const row = rows.get(platform);
      if (!row || row.token !== token || row.outcome !== outcome || row.outcome === null) return { rowCount: 0, rows: [] };
      if (failAudit) throw new Error('audit failed');
      rows.delete(platform); audit.push({platform, token, outcome, actor: args[3]!});
      if (loseReleaseReply) throw new Error('release reply lost');
      return {rowCount: 1, rows: [{operation_id: token}]};
    }
    if (sql.includes('FROM platform_login_recovery_audit')) {
      const row = audit.find(entry => entry.token.toLowerCase() === platform.toLowerCase());
      return {rowCount: row ? 1 : 0, rows: row ? [{operation_id: row.token, platform: row.platform, terminal_outcome: row.outcome, terminal_at: 'terminal-time', actor: row.actor, recovered_at: 'recovery-time'}] : []};
    }
    if (sql.startsWith('SELECT operation_id')) {
      const row = rows.get(platform);
      return {rowCount: row ? 1 : 0, rows: row ? [{operation_id: row.token, terminal_outcome: row.outcome}] : []};
    }
    if (sql.startsWith('INSERT')) {
      if (rows.has(platform)) return { rowCount: 0, rows: [] };
      rows.set(platform, { token, outcome: null }); return { rowCount: 1, rows: [{}] };
    }
    if (sql.startsWith('UPDATE')) {
      if (failUpdate) throw new Error('update failed');
      const row = rows.get(platform);
      if (!row || row.token !== token || row.outcome !== null) return { rowCount: 0, rows: [] };
      row.outcome = outcome;
      terminalEvidence = true;
      if (loseUpdateReply) throw new Error('reply lost after commit');
      return { rowCount: 1, rows: [] };
    }
    if (sql.startsWith('SELECT')) return { rowCount: rows.has(platform) ? 1 : 0, rows: [] };
    throw new Error('unexpected SQL');
  });
  return { rows, audit, query, get terminalEvidence() { return terminalEvidence; }, loseRelease: () => { loseReleaseReply = true; }, failAudit: () => { failAudit = true; }, repo: () => new LoginOperationRepository({query} as unknown as pg.Pool),
    loseReply: () => { loseUpdateReply = true; }, failUpdate: () => { failUpdate = true; } };
}
const ok = {refId:'ipc_fictional', ok:true, error:null};
const transport = (send: AdapterLoginDispatch): AdapterLoginTransport => ({prepareLogin: () => send});

it('reserves before sending, serializes across instances, and releases known results', async () => {
  const db = fakeDatabase(); let finish!: (value: typeof ok) => void;
  const send = vi.fn<AdapterLoginDispatch>().mockImplementationOnce(() => new Promise(resolve => {finish = resolve;})).mockResolvedValue(ok);
  const a = new PersistentLoginOperations(transport(send),db.repo());
  const b = new PersistentLoginOperations(transport(send),db.repo());
  const pending = a.execute('qq','account.login',{});
  await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(await a.current('qq')).toMatchObject({status:'pending',outcome:null});
  expect(await a.execute('qq','account.logout',{})).toEqual({kind:'blocked'});
  expect(await b.execute('qq','account.logout',{})).toEqual({kind:'blocked'});
  expect((await b.execute('telegram','account.login',{})).kind).toBe('ack');
  finish(ok); expect((await pending).kind).toBe('ack');
  expect(await b.current('qq')).toEqual({status:'idle',operationId:null,outcome:null});
  expect(db.audit.map(({platform,outcome,actor})=>({platform,outcome,actor}))).toEqual([
    {platform:'telegram',outcome:'ack',actor:'core'},{platform:'qq',outcome:'ack',actor:'core'},
  ]);
  expect((await b.execute('qq','account.logout',{})).kind).toBe('ack');
  expect(send).toHaveBeenCalledTimes(3);
});

it.each(['transport timeout','negative ACK','restart after reserve'])('never resends following %s', async mode => {
  const db = fakeDatabase();
  if (mode === 'restart after reserve') await db.repo().reserve('qq');
  else {
    const send = mode === 'transport timeout' ? vi.fn<AdapterLoginDispatch>().mockRejectedValue(new Error('timeout')) : vi.fn<AdapterLoginDispatch>().mockResolvedValue({...ok,ok:false,error:'BAD_MESSAGE'});
    const result = await new PersistentLoginOperations(transport(send),db.repo()).execute('qq','account.login.submit',{value:'sensitive'});
    expect(result.kind).toBe(mode==='transport timeout'?'unknown':'ack');
  }
  const send = vi.fn<AdapterLoginDispatch>();
  const restarted = new PersistentLoginOperations(transport(send),db.repo());
  const observed = await restarted.current('qq');
  expect(observed).toEqual({status:'unknown',operationId:db.rows.get('qq')?.token,outcome:null});
  expect(await restarted.release('qq',observed.operationId!,'ack','operator')).toBe(false);
  expect(await restarted.execute('qq','account.login',{})).toEqual({kind:'blocked'});
  expect(send).not.toHaveBeenCalled();
  expect(JSON.stringify(db.query.mock.calls)).not.toContain('sensitive');
});

it('does not reserve when a local preflight rejects; records and releases a later definite no-send', async () => {
  const db = fakeDatabase();
  const refused = new PersistentLoginOperations({prepareLogin:()=>{throw new AdapterAdmissionRejected('CAPABILITY_UNSUPPORTED');}},db.repo());
  expect(await refused.execute('qq','account.login',{})).toEqual({kind:'rejected',code:'CAPABILITY_UNSUPPORTED'});
  expect(db.rows.size).toBe(0); expect(db.audit).toEqual([]);
  const disconnected = new PersistentLoginOperations(transport(()=>{throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE');}),db.repo());
  expect(await disconnected.execute('qq','account.login',{})).toEqual({kind:'rejected',code:'CHANNEL_UNAVAILABLE'});
  expect(await disconnected.current('qq')).toEqual({status:'idle',operationId:null,outcome:null});
  expect(db.audit).toMatchObject([{platform:'qq',outcome:'offline',actor:'core'}]);
});

it('never dispatches after uncertain reservation, even when the INSERT committed', async () => {
  const db = fakeDatabase(); const repo = db.repo();
  const reserve = repo.reserve.bind(repo);
  vi.spyOn(repo,'reserve').mockImplementation(async platform=>{await reserve(platform); throw new Error('reply lost');});
  const send = vi.fn<AdapterLoginDispatch>();
  expect(await new PersistentLoginOperations(transport(send),repo).execute('qq','account.login',{})).toEqual({kind:'unknown'});
  expect(send).not.toHaveBeenCalled(); expect(db.rows.get('qq')?.outcome).toBeNull();
});

it.each(['lost terminal reply', 'failed terminal update', 'audit failure'])('blocks after %s, exposing terminal only when durable', async mode => {
  const db = fakeDatabase();
  if (mode === 'lost terminal reply') db.loseReply();
  else if (mode === 'failed terminal update') db.failUpdate();
  else db.failAudit();
  const send = vi.fn<AdapterLoginDispatch>().mockResolvedValue(ok);
  const ops = new PersistentLoginOperations(transport(send),db.repo());
  expect(await ops.execute('qq','account.login',{})).toEqual({kind:'unknown'});
  expect(db.terminalEvidence).toBe(mode !== 'failed terminal update');
  const restarted = new PersistentLoginOperations(transport(send),db.repo());
  const current = await restarted.current('qq');
  const expected = mode === 'failed terminal update' ? 'unknown' : 'terminal';
  expect(current).toEqual({status:expected,operationId:db.rows.get('qq')?.token,outcome:expected==='terminal'?'ack':null});
  expect(await restarted.execute('qq','account.logout',{})).toEqual({kind:'blocked'});
  expect(send).toHaveBeenCalledTimes(1);
  if (mode==='lost terminal reply') {
    expect(await restarted.release('qq', current.operationId!, 'ack', 'operator')).toBe(true);
    expect(await restarted.recovery('qq', current.operationId!)).toMatchObject({actor:'operator',outcome:'ack'});
  }
});

it('uses exact audit evidence to resolve an automatic release whose reply was lost', async () => {
  const db = fakeDatabase(); db.loseRelease();
  const ops = new PersistentLoginOperations(transport(async()=>ok),db.repo());
  expect(await ops.execute('qq','account.login',{})).toEqual({kind:'ack',ack:ok});
  expect(await ops.current('qq')).toEqual({status:'idle',operationId:null,outcome:null});
  expect(db.audit).toMatchObject([{outcome:'ack',actor:'core'}]);
});

it('records late correlated evidence but requires exact operator release', async () => {
  const db = fakeDatabase(); let late!: (ack:typeof ok)=>Promise<void>;
  const ops = new PersistentLoginOperations(transport(async observe=>{late=observe!; throw new Error('timeout');}),db.repo());
  expect(await ops.execute('telegram','account.login',{})).toEqual({kind:'unknown'});
  const id=(await ops.current('telegram')).operationId!;
  expect(await ops.release('telegram',id,'ack','operator')).toBe(false);
  await late(ok);
  expect(await ops.current('telegram')).toEqual({status:'terminal',operationId:id,outcome:'ack'});
  expect(await ops.release('qq',id,'ack','operator')).toBe(false);
  expect(await ops.release('telegram',id,'offline','operator')).toBe(false);
  expect(await ops.release('telegram',id,'ack','operator')).toBe(true);
  const newer=await db.repo().reserve('telegram');
  expect(await ops.release('telegram',id,'ack','operator')).toBe(true); // same audit, not a new mutation
  await late(ok);
  expect(await ops.current('telegram')).toEqual({status:'unknown',operationId:newer,outcome:null});
  expect(await ops.recovery('qq',id)).toBeNull(); expect(db.audit).toHaveLength(1);
});

it('rejects invalid recovery inputs without touching the database', async () => {
  const db = fakeDatabase(); const repo = db.repo();
  await expect(repo.releaseTerminal('qq','invalid','ack','operator')).rejects.toThrow('invalid recovery request');
  await expect(repo.releaseTerminal('qq','00000000-0000-4000-8000-000000000000','ack','')).rejects.toThrow('invalid recovery request');
  await expect(repo.inspectRecovery('invalid')).rejects.toThrow('invalid recovery request');
  expect(db.query).not.toHaveBeenCalled();
});

it('connects authenticated step and operation routes to a live synthetic handshake and exact late ACK', async () => {
  vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});
  const db=fakeDatabase();
  const manager=new AdapterManager({onEvent:async()=>{},onDisconnect:async()=>{}},5_000);
  const app=Fastify();
  const ops=new PersistentLoginOperations(manager,db.repo());
  registerChannelControlRoutes(app,ops,async t=>t==='test-token'?'admin1':null,{loginStep:p=>manager.loginStep(p)});
  const headers={authorization:'Bearer test-token'};
  const base='/api/channels/telegram/login';
  const writes:Uint8Array[]=[];
  const socket={write:(bytes:Uint8Array)=>writes.push(bytes),destroy:()=>{}};
  const link=manager.attach('telegram',socket);
  const emit=(type:string,payload:unknown,n:number)=>link.data(encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type,id:'ipc_'+String(n).padStart(26,'0'),ts:1,payload})}));
  let written!:()=>void;
  const submitting=new Promise<void>(resolve=>{written=resolve;});
  socket.write=(bytes)=>{writes.push(bytes); if (writes.length===5) written(); return writes.length;};
  try {
    emit('adapter.hello',{platform:'telegram',adapterVersion:'fake',protocol:1},1);
    emit('capabilities',{login:true,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0},2);
    emit('account.state',{state:'login_pending',selfId:null,alias:null,detail:null},3);
    emit('login.step',{step:'code',qrPngBase64:null,hint:null},4);
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.inject({url:base+'/step',headers})).json()).toEqual({data:{step:'code',qrPngBase64:null,hint:null}});
    const submit=Promise.resolve(app.inject({method:'POST',url:base+'/submit',headers,payload:{step:'code',value:'fictional'}}));
    await submitting;
    const command = new IpcDecoder().push(writes[4]!)[0]!;
    expect(command.type).toBe(1); if(command.type!==1) throw Error('expected control');
    const sent=decodeAdapterJson(command.data);
    expect(sent.type).toBe('account.login.submit');
    expect((await app.inject({url:base+'/step',headers})).json()).toEqual({data:null});
    await vi.advanceTimersByTimeAsync(5_000); expect((await submit).statusCode).toBe(504);
    const current=(await app.inject({url:base+'/operation',headers})).json().data as {operationId:string;status:string};
    expect(current.status).toBe('unknown');
    emit('account.state',{state:'logged_in',selfId:'different',alias:null,detail:null},5);
    await vi.advanceTimersByTimeAsync(0);
    expect((await app.inject({url:base+'/operation',headers})).json().data.status).toBe('unknown');
    emit('ack',{refId:sent.id,ok:true,error:null},6);
    await manager.drainEvidence();
    expect((await app.inject({url:base+'/operation',headers})).json()).toEqual({data:{status:'terminal',operationId:current.operationId,outcome:'ack'}});
    expect((await app.inject({method:'POST',url:base+'/operation/release',headers,payload:{operationId:current.operationId,outcome:'ack'}})).statusCode).toBe(200);
    expect((await app.inject({url:base+'/operation/recovery/'+current.operationId,headers})).json().data).toMatchObject({actor:'admin1',outcome:'ack'});
  } finally {manager.close();await app.close();vi.useRealTimers();}
});
