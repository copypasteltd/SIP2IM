import {describe,it,expect,vi} from 'vitest';
import type pg from 'pg';
import {IncomingSmsOutbox,enqueueIncomingSms} from '../src/sms/incoming-outbox.js';
import {TransactionCommitUnknown} from '../src/db/pool.js';

const row={eventId:'evt_1',id:'sms_1',deviceId:'dev_1',simId:null,direction:'in',peer:'123',peerKind:'number',body:'hello',parts:1,occurredAt:'1000'};
function fakePool() {
  let pending=true, deleted=false, failCommit: 'before'|'after'|undefined;
  const commitFailure=new Error('commit response lost');
  const query=vi.fn(async (sql:string) => {
    if(sql==='BEGIN'){deleted=false;return {rows:[],rowCount:0};}
    if(sql==='ROLLBACK'){deleted=false;return {rows:[],rowCount:0,command:'ROLLBACK'};}
    if(sql==='COMMIT'){const failure=failCommit;failCommit=undefined;if(deleted&&failure!=='before')pending=false;if(failure)throw commitFailure;return {rows:[],rowCount:0,command:'COMMIT'};}
    if(sql.includes('FOR UPDATE OF o SKIP LOCKED'))return {rows:pending?[row]:[],rowCount:pending?1:0};
    if(sql.startsWith('DELETE FROM')){deleted=true;return {rows:[],rowCount:1};}
    throw Error('unexpected SQL: '+sql);
  });
  const client={query,release:vi.fn()};
  return {pool:{connect:async()=>client} as unknown as pg.Pool,client,commitFailure,hasPending:()=>pending,failNextCommit:(when:'before'|'after')=>{failCommit=when;}};
}
describe('incoming SMS outbox',()=>{
  it('enqueues idempotently on the caller transaction',async()=>{
    const query=vi.fn(async()=>({rows:[],rowCount:1}));
    await enqueueIncomingSms({query} as unknown as pg.PoolClient,'evt_1');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ON CONFLICT (event_id) DO NOTHING'),['evt_1']);
  });
  it('coalesces concurrent flushes and consumes a fanout attempt with no clients',async()=>{
    const db=fakePool();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve});
    const publish=vi.fn(async()=>{await gate});const outbox=new IncomingSmsOutbox(db.pool,publish);
    const a=outbox.flush(),b=outbox.flush();expect(a).toBe(b);release();await Promise.all([a,b]);
    expect(publish).toHaveBeenCalledTimes(1);expect(publish).toHaveBeenCalledWith('sms.new',{id:'sms_1',deviceId:'dev_1',simId:null,direction:'in',peer:'123',peerKind:'number',body:'hello',parts:1,occurredAt:1000,task:null});
    expect(db.hasPending()).toBe(false);await outbox.flush();expect(publish).toHaveBeenCalledTimes(1);
  });
  it('retains pending work on publish failure and retries',async()=>{
    const db=fakePool();const publish=vi.fn().mockRejectedValueOnce(Error('failed')).mockResolvedValue(undefined);
    const outbox=new IncomingSmsOutbox(db.pool,publish);await expect(outbox.flush()).rejects.toThrow('failed');
    expect(db.hasPending()).toBe(true);await outbox.flush();expect(publish).toHaveBeenCalledTimes(2);expect(db.hasPending()).toBe(false);
  });
  it.each(['before','after'] as const)('reports uncertain commit when the response is lost %s application',async when=>{
    const db=fakePool();db.failNextCommit(when);const publish=vi.fn(async()=>{});const outbox=new IncomingSmsOutbox(db.pool,publish);
    const error=await outbox.flush().catch(e=>e);
    expect(error).toBeInstanceOf(TransactionCommitUnknown);expect(error.cause).toBe(db.commitFailure);
    expect(db.client.release).toHaveBeenCalledWith(true);expect(db.hasPending()).toBe(when==='before');
    await outbox.flush();expect(publish).toHaveBeenCalledTimes(when==='before'?2:1);
    if(when==='before')expect(publish.mock.calls[0]).toEqual(publish.mock.calls[1]);
    expect(db.hasPending()).toBe(false);
  });
  it('rechecks after a wake while an empty read is in flight',async()=>{
    let count=0, pending=false, resume!:()=>void, observed!:()=>void;
    const gate=new Promise<void>(r=>{resume=r}), readStarted=new Promise<void>(r=>{observed=r});
    const query=vi.fn(async(sql:string)=>{if(sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],command:sql};
      if(sql.includes('FOR UPDATE')){count++;if(count===1){observed();await gate;return {rows:[]};}return {rows:pending?[row]:[]};}
      if(sql.startsWith('DELETE'))pending=false;
      return {rows:[]};
    });
    const pool={connect:async()=>({query,release(){}})} as unknown as pg.Pool;
    const publish=vi.fn(async()=>{}), outbox=new IncomingSmsOutbox(pool,publish);
    const first=outbox.flush();await readStarted;pending=true;expect(outbox.flush()).toBe(first);resume();await first;
    expect(publish).toHaveBeenCalledTimes(1);expect(count).toBe(3);
  });
  it('continues after a full batch and stops polling once empty',async()=>{
    let pending=205, reads=0, yields=0;
    const query=vi.fn(async(sql:string)=>{if(sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],command:sql};
      if(sql.includes('FOR UPDATE')){reads++;return {rows:pending?[row]:[]};}
      if(sql.startsWith('DELETE'))pending--;
      return {rows:[]};
    });
    const pool={connect:async()=>({query,release(){}})} as unknown as pg.Pool;
    const publish=vi.fn(async()=>{}),outbox=new IncomingSmsOutbox(pool,publish);
    setImmediate(()=>{yields++});await outbox.flush();
    expect(publish).toHaveBeenCalledTimes(205);expect(reads).toBe(206);expect(yields).toBe(1);
  });
  it('does not spin on a persistent failure',async()=>{
    const db=fakePool(),publish=vi.fn(async()=>{throw Error('unavailable')});
    const outbox=new IncomingSmsOutbox(db.pool,publish);await expect(outbox.flush()).rejects.toThrow('unavailable');
    await new Promise<void>(resolve=>setImmediate(resolve));expect(publish).toHaveBeenCalledTimes(1);expect(db.hasPending()).toBe(true);
  });
  it('honors a wake during a failing attempt and still reports the failure',async()=>{
    const db=fakePool();let resume!:()=>void,started!:()=>void;
    const gate=new Promise<void>(r=>{resume=r}), entered=new Promise<void>(r=>{started=r});
    const publish=vi.fn().mockImplementationOnce(async()=>{started();await gate;throw Error('first failure');}).mockResolvedValue(undefined);
    const outbox=new IncomingSmsOutbox(db.pool,publish), first=outbox.flush();
    await entered;expect(outbox.flush()).toBe(first);resume();
    await expect(first).rejects.toThrow('first failure');
    expect(publish).toHaveBeenCalledTimes(2);expect(db.hasPending()).toBe(false);
  });
  it('stops before publishing when shutdown arrives during a read',async()=>{
    let resume!:()=>void,started!:()=>void;
    const gate=new Promise<void>(r=>{resume=r}), entered=new Promise<void>(r=>{started=r});
    const query=vi.fn(async(sql:string)=>{if(sql==='COMMIT'||sql==='ROLLBACK')return {rows:[],command:sql};if(sql.includes('FOR UPDATE')){started();await gate;return {rows:[row]};}return {rows:[]};});
    const pool={connect:async()=>({query,release(){}})} as unknown as pg.Pool;
    const publish=vi.fn(async()=>{}),outbox=new IncomingSmsOutbox(pool,publish);
    const flushing=outbox.flush();await entered;const stopping=outbox.stop();resume();await Promise.all([flushing,stopping]);
    expect(publish).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalledWith(expect.stringContaining('DELETE'),expect.anything());
  });
  it('finishes an already-started publication before shutdown resolves',async()=>{
    const db=fakePool();let resume!:()=>void,started!:()=>void;
    const gate=new Promise<void>(r=>{resume=r}), entered=new Promise<void>(r=>{started=r});
    const publish=vi.fn(async()=>{started();await gate}),outbox=new IncomingSmsOutbox(db.pool,publish);
    const flushing=outbox.flush();await entered;let stopped=false;const stopping=outbox.stop().then(()=>{stopped=true});
    await Promise.resolve();expect(stopped).toBe(false);resume();await Promise.all([flushing,stopping]);
    expect(db.hasPending()).toBe(false);expect(publish).toHaveBeenCalledTimes(1);
  });
  it('settles shutdown after an in-flight failure while flush reports it',async()=>{
    const db=fakePool();let resume!:()=>void,started!:()=>void;
    const gate=new Promise<void>(r=>{resume=r}), entered=new Promise<void>(r=>{started=r});
    const publish=vi.fn(async()=>{started();await gate;throw Error('publish failed');});
    const outbox=new IncomingSmsOutbox(db.pool,publish),flushing=outbox.flush();
    const failure=expect(flushing).rejects.toThrow('publish failed');
    await entered;const stopping=outbox.stop();resume();
    await expect(stopping).resolves.toBeUndefined();await failure;
    expect(db.hasPending()).toBe(true);expect(publish).toHaveBeenCalledTimes(1);
  });
  it('stops subsequent dispatch',async()=>{const db=fakePool();const publish=vi.fn(async()=>{});const outbox=new IncomingSmsOutbox(db.pool,publish);await outbox.stop();await outbox.flush();expect(publish).not.toHaveBeenCalled();});
});
