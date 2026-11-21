import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { IncomingSmsOutbox, enqueueIncomingSms } from '../src/sms/incoming-outbox.js';
import { TransactionCommitUnknown } from '../src/db/pool.js';
import { AdminHub } from '../src/ws-admin/hub.js';
import { runWithSignals } from '../src/signal-handling.js';

const version = '2026-11-21T11:26:10.000001Z';
const replacementVersion = '2026-11-21T11:26:10.000002Z';
const row = {
  eventId: 'evt_1', markerVersion: version, id: 'sms_1', deviceId: 'dev_1', simId: null, direction: 'in',
  peer: '123', peerKind: 'number', body: 'hello', parts: 1, occurredAt: '1000',
};
const payload = {id:'sms_1',deviceId:'dev_1',simId:null,direction:'in',peer:'123',peerKind:'number',body:'hello',parts:1,occurredAt:1000,task:null};
const gate = () => { let open!: () => void; const promise = new Promise<void>(resolve => { open = resolve; }); return { promise, open }; };

function fakePool(initial = [row], hooks: { beforeRead?: () => void | Promise<void>; afterDelete?: () => void | Promise<void> } = {}) {
  const markers = new Map(initial.map(marker => [marker.eventId, marker]));
  const commitFailure = new Error('commit response lost');
  let failCommit: 'before' | 'after' | undefined, checkedOut = false;
  let deleting: string | undefined;
  const order: string[] = [];
  const release = vi.fn((_discard?: boolean) => { checkedOut = false; deleting = undefined; order.push('release'); });
  const oneClient = () => {
    if (checkedOut) throw new Error('single connection is already checked out');
    checkedOut = true;
  };
  const query = vi.fn(async (sql: string) => {
    oneClient();
    try {
      if (sql==='SELECT fixture_admin') { order.push('authenticate');return {rows:[{id:'admin'}],rowCount:1}; }
      if (!sql.includes('FROM sms_incoming_admin_outbox o')) throw Error('unexpected pool SQL: '+sql);
      expect(sql).not.toMatch(/FOR UPDATE|FOR SHARE|SKIP LOCKED/);
      expect(sql).toContain('ORDER BY o.created_at,o.event_id LIMIT 1');
      expect(sql).toContain("to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US') || 'Z' AS \"markerVersion\"");
      order.push('read');
      const first = [...markers.values()].sort((a,b)=>a.markerVersion.localeCompare(b.markerVersion)||a.eventId.localeCompare(b.eventId))[0];
      await hooks.beforeRead?.();
      return {rows:first?[{...first}]:[],rowCount:first?1:0};
    } finally { checkedOut = false; }
  });
  const transactionQuery = vi.fn(async (sql: string, args?: unknown[]) => {
    expect(checkedOut).toBe(true);
    if (sql==='BEGIN'){order.push('begin');return {rows:[],rowCount:0,command:sql};}
    if (sql==='SET LOCAL synchronous_commit = on'){order.push('synchronous');return {rows:[],rowCount:0};}
    if (sql==='ROLLBACK'){deleting=undefined;order.push('rollback');return {rows:[],rowCount:0,command:sql};}
    if (sql==='COMMIT'){
      order.push('commit');
      const fail=failCommit;failCommit=undefined;
      if(deleting&&fail!=='before')markers.delete(deleting);
      deleting=undefined;
      if(fail)throw commitFailure;
      return {rows:[],rowCount:0,command:sql};
    }
    if (sql==='DELETE FROM sms_incoming_admin_outbox WHERE event_id=$1 AND created_at=$2::timestamptz') {
      order.push('delete');
      const key=String(args?.[0]);
      const current=markers.get(key);
      deleting=current && current.markerVersion===args?.[1] ? key : undefined;
      await hooks.afterDelete?.();
      return {rows:[],rowCount:deleting?1:0};
    }
    throw Error('unexpected cleanup SQL: '+sql);
  });
  const connect = vi.fn(async () => { oneClient();return {query:transactionQuery,release}; });
  return { pool:{query,connect} as unknown as pg.Pool, query,connect,transactionQuery,release,commitFailure,markers,order,
    failNextCommit:(when:'before'|'after')=>{failCommit=when;}, hasPending:()=>markers.size>0 };
}

const second = {...row,eventId:'evt_2',id:'sms_2',markerVersion:replacementVersion};

describe('incoming SMS outbox', () => {
  it('enqueues idempotently on the caller transaction', async () => {
    const query=vi.fn(async()=>({rows:[],rowCount:1}));
    await enqueueIncomingSms({query} as unknown as pg.PoolClient,'evt_1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (event_id) DO NOTHING'),['evt_1']);
  });

  it('coalesces concurrent flushes and consumes a fanout attempt with no clients', async () => {
    const db=fakePool();
    const hub=new AdminHub(async () => { throw Error('no subscriber'); });
    const publish=vi.fn(hub.publish.bind(hub));
    const outbox=new IncomingSmsOutbox(db.pool,publish);
    const a=outbox.flush(),b=outbox.flush();expect(a).toBe(b);
    await a;
    expect(publish).toHaveBeenCalledExactlyOnceWith('sms.new',payload,expect.any(Function));
    expect(db.hasPending()).toBe(false);
    await outbox.flush();expect(publish).toHaveBeenCalledOnce();
    await hub.stop();
  });

  it('returns a one-slot pool checkout before real hub subscriber authorization and sends the unchanged envelope', async () => {
    const db=fakePool();
    const authorize=vi.fn(async () => {
      const result=await db.pool.query<{id:string}>('SELECT fixture_admin');
      return result.rows[0]?.id??null;
    });
    const hub=new AdminHub(authorize);
    const socket={send:vi.fn<(message:string)=>void>(),close:vi.fn()};
    hub.add(socket,'fixture-admin');
    await new IncomingSmsOutbox(db.pool,hub.publish.bind(hub)).flush();
    expect(authorize).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledOnce();expect(socket.close).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.calls[0]![0])).toEqual({type:'sms.new',data:payload,ts:expect.any(Number)});
    expect(db.order).toEqual(['read','authenticate','begin','synchronous','delete','commit','release','read']);
    expect(db.transactionQuery).toHaveBeenCalledWith(expect.stringContaining('created_at=$2::timestamptz'),[row.eventId,version]);
    await hub.stop();
  });

  it('retains pending work on publish failure and retries only on a later wake', async () => {
    const db=fakePool();
    const publish=vi.fn().mockRejectedValueOnce(Error('failed')).mockResolvedValue(undefined);
    const outbox=new IncomingSmsOutbox(db.pool,publish);
    await expect(outbox.flush()).rejects.toThrow('failed');
    expect(db.hasPending()).toBe(true);expect(db.connect).not.toHaveBeenCalled();
    await outbox.flush();expect(publish).toHaveBeenCalledTimes(2);expect(db.hasPending()).toBe(false);
  });

  it.each(['before','after'] as const)('reports uncertain cleanup commit when the response is lost %s application', async when => {
    const db=fakePool();db.failNextCommit(when);
    const publish=vi.fn(async()=>{}),outbox=new IncomingSmsOutbox(db.pool,publish);
    const error=await outbox.flush().catch(e=>e);
    expect(error).toBeInstanceOf(TransactionCommitUnknown);expect(error.cause).toBe(db.commitFailure);
    expect(db.release).toHaveBeenCalledWith(true);expect(db.hasPending()).toBe(when==='before');
    await outbox.flush();expect(publish).toHaveBeenCalledTimes(when==='before'?2:1);
    if(when==='before')expect(publish).toHaveBeenNthCalledWith(2,'sms.new',payload,expect.any(Function));
    expect(db.hasPending()).toBe(false);
  });

  it('cannot delete a replacement marker, including when its creation time differs only in microseconds', async () => {
    const db=fakePool();
    const publish=vi.fn().mockImplementationOnce(async()=>db.markers.set(row.eventId,{...row,markerVersion:replacementVersion})).mockResolvedValue(undefined);
    const outbox=new IncomingSmsOutbox(db.pool,publish);
    await outbox.flush();
    expect(publish).toHaveBeenCalledOnce();expect(db.query).toHaveBeenCalledOnce();
    expect(db.markers.get(row.eventId)?.markerVersion).toBe(replacementVersion);
    expect(db.transactionQuery).toHaveBeenCalledWith(expect.stringContaining('created_at=$2::timestamptz'),[row.eventId,version]);
    await outbox.flush();
    expect(db.transactionQuery).toHaveBeenCalledWith(expect.stringContaining('created_at=$2::timestamptz'),[row.eventId,replacementVersion]);
    expect(db.hasPending()).toBe(false);
  });

  it('requires a marker version before attempting a notification', async () => {
    const db=fakePool([{...row,markerVersion:''}]);const publish=vi.fn(async()=>{});
    await expect(new IncomingSmsOutbox(db.pool,publish).flush()).rejects.toThrow('INCOMING_SMS_NOTIFICATION_MARKER_MISSING');
    expect(publish).not.toHaveBeenCalled();expect(db.connect).not.toHaveBeenCalled();expect(db.hasPending()).toBe(true);
  });

  it('rechecks after a wake while an empty read is in flight', async () => {
    const entered=gate(), resume=gate();let firstRead=true;
    const db=fakePool([], {beforeRead:async()=>{if(firstRead){firstRead=false;entered.open();await resume.promise;}}});
    const publish=vi.fn(async()=>{}),outbox=new IncomingSmsOutbox(db.pool,publish);
    const flushing=outbox.flush();await entered.promise;
    db.markers.set(row.eventId,row);expect(outbox.flush()).toBe(flushing);
    resume.open();await flushing;
    expect(publish).toHaveBeenCalledOnce();expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('continues after full batches and stops once empty', async () => {
    const pending=Array.from({length:205},(_,i)=>({...row,eventId:'evt_'+String(i).padStart(3,'0'),id:'sms_'+i}));
    const db=fakePool(pending);
    let yieldedAt: number | undefined;
    const publish=vi.fn(async()=>{}),outbox=new IncomingSmsOutbox(db.pool,publish);
    setImmediate(()=>{yieldedAt=publish.mock.calls.length;});
    await outbox.flush();
    expect(publish).toHaveBeenCalledTimes(205);expect(db.query).toHaveBeenCalledTimes(206);
    expect(yieldedAt).toBe(100);expect(db.hasPending()).toBe(false);
  });

  it('does not spin on a persistent failure', async () => {
    const db=fakePool(),publish=vi.fn(async()=>{throw Error('unavailable');});
    const outbox=new IncomingSmsOutbox(db.pool,publish);
    await expect(outbox.flush()).rejects.toThrow('unavailable');
    await new Promise<void>(resolve=>setImmediate(resolve));
    expect(publish).toHaveBeenCalledOnce();expect(db.hasPending()).toBe(true);
  });

  it('honors a wake during a failing attempt and still reports the failure', async () => {
    const db=fakePool(),entered=gate(),resume=gate();
    const publish=vi.fn().mockImplementationOnce(async()=>{entered.open();await resume.promise;throw Error('first failure');}).mockResolvedValue(undefined);
    const outbox=new IncomingSmsOutbox(db.pool,publish),flushing=outbox.flush();
    const failed=expect(flushing).rejects.toThrow('first failure');
    await entered.promise;expect(outbox.flush()).toBe(flushing);resume.open();
    await failed;expect(publish).toHaveBeenCalledTimes(2);expect(db.hasPending()).toBe(false);
  });

  it('registers the active worker before a pool port can reenter flush or stop', async () => {
    let outbox!: IncomingSmsOutbox, reentrant: Promise<void> | undefined, closing: Promise<void> | undefined;
    const db=fakePool([row],{beforeRead:()=>{reentrant=outbox.flush();closing=outbox.stop();}});
    const publish=vi.fn(async()=>{});outbox=new IncomingSmsOutbox(db.pool,publish);
    const flushing=outbox.flush();await flushing;await closing;
    expect(reentrant).toBe(flushing);
    expect(db.query).toHaveBeenCalledOnce();expect(publish).not.toHaveBeenCalled();expect(db.hasPending()).toBe(true);
  });

  it.each(['explicit worker stop','Core abort'] as const)('freezes new publication when %s arrives during a read', async reason => {
    const entered=gate(),resume=gate(),controller=new AbortController();
    const db=fakePool([row],{beforeRead:async()=>{entered.open();await resume.promise;}});
    const publish=vi.fn(async()=>{}),outbox=new IncomingSmsOutbox(db.pool,publish,{stopping:controller.signal});
    const flushing=outbox.flush();await entered.promise;
    const stopping=reason==='Core abort'?undefined:outbox.stop();
    if(reason==='Core abort')controller.abort();
    resume.open();await flushing;await stopping;
    await outbox.flush();await outbox.stop();
    expect(db.query).toHaveBeenCalledOnce();expect(publish).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();expect(db.hasPending()).toBe(true);
  });

  it('fences a read already in progress before cleanup of a failed startup', async () => {
    const dbRead=gate(), resume=gate();
    const db=fakePool([row],{beforeRead:async()=>{dbRead.open();await resume.promise;}});
    const publish=vi.fn(async()=>{}), startupFailure=new Error('next startup step failed');
    let worker: IncomingSmsOutbox | undefined, flushing: Promise<void> | undefined;
    const source={on:vi.fn(),off:vi.fn()};
    const result=await runWithSignals(source,async stopping=>{
      worker=new IncomingSmsOutbox(db.pool,publish,{stopping});
      flushing=worker.flush();await dbRead.promise;
      throw startupFailure;
    },async()=>{
      // A committed-event wake may still reach the worker as cleanup begins.
      const wake=worker?.flush();
      resume.open();
      await Promise.all([flushing,wake]);
      await worker?.stop();
    });
    expect(result).toMatchObject({signal:undefined,startupFailed:true,startupError:startupFailure,cleanupFailed:false});
    expect(db.query).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();expect(db.connect).not.toHaveBeenCalled();expect(db.hasPending()).toBe(true);
  });

  it('drains the published marker on Core abort without starting a second notification', async () => {
    const db=fakePool([row,second]),entered=gate(),resume=gate(),controller=new AbortController();
    const publish=vi.fn(async(_type:string,_data:unknown,current:()=>boolean)=>{entered.open();await resume.promise;expect(current()).toBe(true);});
    const outbox=new IncomingSmsOutbox(db.pool,publish,{stopping:controller.signal});
    const flushing=outbox.flush();await entered.promise;
    controller.abort();const stopped=vi.fn();const stopping=outbox.stop().then(stopped);
    await Promise.resolve();expect(stopped).not.toHaveBeenCalled();
    resume.open();await Promise.all([flushing,stopping]);
    expect(stopped).toHaveBeenCalledOnce();expect(publish).toHaveBeenCalledOnce();
    expect([...db.markers.keys()]).toEqual([second.eventId]);expect(db.query).toHaveBeenCalledOnce();
  });

  it('leaves the marker if an admitted publication fails while stop is draining', async () => {
    const db=fakePool(),entered=gate(),resume=gate();
    const publish=vi.fn(async()=>{entered.open();await resume.promise;throw Error('publish failed');});
    const outbox=new IncomingSmsOutbox(db.pool,publish),flushing=outbox.flush();
    const failure=expect(flushing).rejects.toThrow('publish failed');
    await entered.promise;const stopping=outbox.stop();resume.open();
    await expect(stopping).resolves.toBeUndefined();await failure;
    expect(db.hasPending()).toBe(true);expect(publish).toHaveBeenCalledOnce();expect(db.connect).not.toHaveBeenCalled();
  });

  it('does not publish if database ownership is lost while reading', async () => {
    let owns=true;
    const loss=new Error('ownership lost');
    const db=fakePool([row],{beforeRead:()=>{owns=false;}}),publish=vi.fn(async()=>{});
    const outbox=new IncomingSmsOutbox(db.pool,publish,{assertOwnership:()=>{if(!owns)throw loss;}});
    await expect(outbox.flush()).rejects.toBe(loss);
    expect(publish).not.toHaveBeenCalled();expect(db.connect).not.toHaveBeenCalled();expect(db.hasPending()).toBe(true);
  });

  it('rechecks ownership after subscriber authorization and retains the marker on loss', async () => {
    let owns=true;
    const loss=new Error('ownership lost');
    const db=fakePool(),entered=gate(),resume=gate();
    const hub=new AdminHub(async ()=>{entered.open();await resume.promise;return 'admin';});
    const socket={send:vi.fn(),close:vi.fn()};hub.add(socket,'fixture-admin');
    const outbox=new IncomingSmsOutbox(db.pool,hub.publish.bind(hub),{assertOwnership:()=>{if(!owns)throw loss;}});
    const failure=expect(outbox.flush()).rejects.toBe(loss);
    await entered.promise;owns=false;resume.open();await failure;
    expect(socket.send).not.toHaveBeenCalled();expect(socket.close).not.toHaveBeenCalled();
    expect(db.connect).not.toHaveBeenCalled();expect(db.hasPending()).toBe(true);
    await hub.stop();
  });

  it('rolls back exact cleanup if ownership is lost before issuing COMMIT', async () => {
    let owns=true;
    const loss=new Error('ownership lost');
    const db=fakePool([row],{afterDelete:()=>{owns=false;}}),publish=vi.fn(async()=>{});
    const outbox=new IncomingSmsOutbox(db.pool,publish,{assertOwnership:()=>{if(!owns)throw loss;}});
    await expect(outbox.flush()).rejects.toBe(loss);
    expect(publish).toHaveBeenCalledOnce();
    expect(db.order).toEqual(['read','begin','synchronous','delete','rollback','release']);
    expect(db.release).toHaveBeenCalledWith(true);expect(db.hasPending()).toBe(true);
  });

  it('stops subsequent dispatch', async () => {
    const db=fakePool(),publish=vi.fn(async()=>{});
    const outbox=new IncomingSmsOutbox(db.pool,publish);await outbox.stop();await outbox.flush();
    expect(publish).not.toHaveBeenCalled();expect(db.query).not.toHaveBeenCalled();
  });
});
