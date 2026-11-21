import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { PgWebCallStore, type WebCallIds } from '../src/calls/web-call-store.js';
import { WEB_RESERVATION_SWEEP_PAGE, WebReservationMaintenance, endUnarmedWebReservation,
  expiredWebReservation, unarmedWebReservation } from '../src/calls/web-reservations.js';

const ids: WebCallIds = { id:'session', deviceId:'device', browserLegId:'browser', cellularLegId:'cell',
  callId:'call', generation:'generation', connectionId:'attachment' };
const dbResult = (rows: unknown[] = [], rowCount = rows.length, command = 'SELECT') => ({ rows, rowCount, command });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { resolve, promise }; };
const cmd = 'cmd_fixture';
const sim = { slot:0, subId:1 };
const simId = 'sim';

it('requires original creation and cellular identity events, two untouched legs and no action evidence', () => {
  expect(unarmedWebReservation).toContain("s.kind='web_out' AND s.state='awaiting_browser'");
  expect(unarmedWebReservation).toContain('l.connected_at IS NULL');
  expect(unarmedWebReservation).toContain('l.ended_at IS NULL');
  expect(unarmedWebReservation).toMatch(/count\(\*\)=2[\s\S]+l.type='browser'[\s\S]+l.type='cellular'/);
  expect(unarmedWebReservation).toContain('NOT EXISTS (SELECT 1 FROM call_outbound_attempt');
  expect(unarmedWebReservation).toContain('NOT EXISTS (SELECT 1 FROM call_reject_intent');
  expect(unarmedWebReservation).toMatch(/count\(\*\)=2[\s\S]+e.event='state:awaiting_browser'[\s\S]+e.event='cellular.identity.v1'/);
  expect(unarmedWebReservation).toContain("e.payload->>'reason'='awaiting_browser_media'");
  expect(unarmedWebReservation).toContain("cell.ref_id=(e.payload->>'callId')");
});

const maintenanceFixture = (options: {
  candidates?: Array<{id:string; device_id:string}>; beforeProof?: () => void; afterWrite?: () => void;
  commitGate?: Promise<void>; skipDevice?: string; skipSession?: string; stale?: string;
  lostCommit?: boolean; failureFor?: string; legCount?: number; sessionCount?: number;
} = {}) => {
  const entries = options.candidates ?? [{id:ids.id,device_id:ids.deviceId}];
  const spent = new Set<string>();
  let activeSession: string | undefined;
  const committed = deferred();
  const query = vi.fn(async (sql:string, params:unknown[] = []) => {
    if (['BEGIN','ROLLBACK'].includes(sql)) return dbResult([],0,sql);
    if (sql==='COMMIT') {
      committed.resolve(); await options.commitGate;
      if (options.lostCommit) throw new Error('lost COMMIT response');
      return dbResult([],0,sql);
    }
    if (sql.startsWith('SET ')) return dbResult();
    if (sql.startsWith('SELECT id FROM device')) {
      expect(sql).toContain('FOR UPDATE SKIP LOCKED');
      return params[0]===options.skipDevice?dbResult():dbResult([{}]);
    }
    if (sql.includes('AND device_id=$2 FOR UPDATE SKIP LOCKED')) {
      const expected=entries.find(entry=>entry.id===params[0]);
      expect(params).toEqual([expected?.id,expected?.device_id]);
      return params[0]===options.skipSession?dbResult():dbResult([{}]);
    }
    if (sql==='SELECT id FROM call_session WHERE id=$1 FOR UPDATE') return dbResult([{}]);
    if (sql.startsWith('SELECT 1 FROM call_session s WHERE s.id=')) {
      const id=String(params[0]);
      expect(params[1]).toBe(true);
      expect(sql).toContain(expiredWebReservation);
      options.beforeProof?.();
      if (spent.has(id) || id===options.stale) return dbResult();
      activeSession=id;
      return dbResult([{}]);
    }
    if (sql.startsWith('UPDATE call_leg')) {
      expect(params).toEqual([activeSession]);
      expect(sql).toContain("type IN ('browser','cellular') AND state='created'");
      return dbResult([],options.legCount??2);
    }
    if (sql.startsWith('UPDATE call_session')) {
      expect(params).toEqual([activeSession,'awaiting_browser','ended',null]);
      return dbResult([],options.sessionCount??1);
    }
    if (sql.startsWith('INSERT INTO call_event')) {
      expect(params.slice(1)).toEqual([activeSession, 'state:ended', '{"reason":"browser_reservation_expired"}']);
      if (activeSession===options.failureFor) throw new Error('event write failed');
      spent.add(String(activeSession));
      options.afterWrite?.();
      return dbResult([],1);
    }
    throw new Error('Unexpected query: '+sql);
  });
  const inventory = vi.fn(async(sql:string, params:unknown[])=>{
    expect(sql).toContain('ORDER BY s.id LIMIT $2');
    expect(sql).toContain("s.kind='web_out' AND s.state='awaiting_browser'");
    expect(sql).toContain(expiredWebReservation);
    expect(params[1]).toBe(WEB_RESERVATION_SWEEP_PAGE);
    return {rows:entries.filter(row=>params[0]===null||row.id>String(params[0])).slice(0, Number(params[1]))};
  });
  const release = vi.fn();
  const connect = vi.fn(async()=>({query,release}));
  const pool={query:inventory,connect} as unknown as pg.Pool;
  return {maintenance:new WebReservationMaintenance(pool),query,inventory,connect,release,committed};
};

it('visits bounded pages, skips locked or stale candidates and wraps for later recovery',async()=>{
  const candidates=Array.from({length:WEB_RESERVATION_SWEEP_PAGE+2},(_,i)=>({id:'s'+String(i).padStart(2,'0'),device_id:'d'+i}));
  const f=maintenanceFixture({candidates,skipDevice:'d1',skipSession:'s02',stale:'s03'});
  const publish=vi.fn(async(_id:string)=>{});
  await f.maintenance.sweep(()=>{},publish);
  expect(f.inventory.mock.calls[0]?.[1]).toEqual([null,16]);
  expect(f.connect).toHaveBeenCalledTimes(16);
  expect(publish.mock.calls.map(([id])=>id)).toEqual(candidates.slice(0,16).filter((_,i)=>i===0||i>3).map(x=>x.id));
  expect(f.query.mock.calls.some(([,args])=>args?.[0]==='s01')).toBe(false);
  expect(f.query.mock.calls.some(([sql,args])=>sql.startsWith('UPDATE call_leg')&&args?.[0]==='s03')).toBe(false);
  await f.maintenance.sweep(()=>{},publish);
  expect(f.inventory.mock.calls[1]?.[1]).toEqual(['s15',16]);
  expect(publish.mock.calls.slice(-2)).toEqual([['s16'],['s17']]);
  await f.maintenance.sweep(()=>{},publish);
  expect(f.inventory.mock.calls[2]?.[1]).toEqual([null,16]);
  expect(publish).toHaveBeenCalledTimes(15);
});

it('publishes only after COMMIT for each reservation and never publishes an uncertain commit',async()=>{
  const gate=deferred(), f=maintenanceFixture({commitGate:gate.promise});
  const publish=vi.fn(async(_id:string)=>{});
  const sweep=f.maintenance.sweep(()=>{},publish);
  try { await f.committed.promise; expect(publish).not.toHaveBeenCalled(); }
  finally { gate.resolve(); await sweep; }
  expect(publish).toHaveBeenCalledWith(ids.id);
  const unknown=maintenanceFixture({lostCommit:true}), update=vi.fn(async()=>{});
  await expect(unknown.maintenance.sweep(()=>{},update)).rejects.toThrow('Web reservation maintenance failed');
  expect(update).not.toHaveBeenCalled();
  expect(unknown.release).toHaveBeenCalledWith(true);
});

it.each([{legCount:1},{sessionCount:0},{failureFor:ids.id}])('rolls back a partial state change or event failure',async options=>{
  const f=maintenanceFixture(options), publish=vi.fn(async()=>{});
  await expect(f.maintenance.sweep(()=>{},publish)).rejects.toThrow('Web reservation maintenance failed');
  expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  expect(publish).not.toHaveBeenCalled();
});

it('does not block the next candidate after a rolled-back event error',async()=>{
  const f=maintenanceFixture({candidates:[{id:'a',device_id:'d1'},{id:'b',device_id:'d2'}],failureFor:'a'});
  const publish=vi.fn(async(_id:string)=>{});
  await expect(f.maintenance.sweep(()=>{},publish)).rejects.toThrow('Web reservation maintenance failed');
  expect(f.query.mock.calls.map(([sql])=>sql).filter(sql=>sql==='ROLLBACK'||sql==='COMMIT')).toEqual(['ROLLBACK','COMMIT']);
  expect(publish.mock.calls).toEqual([['b']]);
});

it('stops starting candidates on shutdown and rolls back an in-flight write when ownership is lost',async()=>{
  const controller=new AbortController(); const f=maintenanceFixture({afterWrite:()=>controller.abort()});
  const publish=vi.fn(async()=>{});
  await f.maintenance.sweep(()=>{},publish,controller.signal);
  expect(f.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  expect(publish).not.toHaveBeenCalled();
  await f.maintenance.sweep(()=>{},publish,controller.signal);
  expect(f.inventory).toHaveBeenCalledOnce();
  let owned=true; const lost=maintenanceFixture({afterWrite:()=>{owned=false;}});
  await expect(lost.maintenance.sweep(()=>{if(!owned)throw new Error('ownership lost');},publish)).rejects.toThrow('Web reservation maintenance failed');
  expect(lost.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  expect(publish).not.toHaveBeenCalled();
});

const storeFixture = (options:{ tooLate?:boolean; staleProof?:boolean; browserMissing?:boolean; cellularState?:string;
  busy?:boolean; afterArmInsert?:()=>void } = {}) => {
  const query=vi.fn(async(sql:string,args:unknown[] = [])=>{
    if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return dbResult([],0,sql);
    if (sql.startsWith('SET ')) return dbResult();
    if (sql.includes('pg_advisory_xact_lock')) return dbResult([{}]);
    if (sql.includes('WHERE idempotency_key=')) return dbResult();
    if (sql.startsWith('SELECT enabled,online')) return dbResult([{enabled:true,online:true,paused:false,call_enabled:true}]);
    if (sql.startsWith('SELECT field FROM device_status')) return dbResult([{}, {}, {}, {}]);
    if (sql.startsWith('SELECT slot,sub_id')) return dbResult([sim]);
    if (sql.startsWith('SELECT id FROM device')) return dbResult([{id:ids.deviceId}]);
    if (sql.includes('AS "legState"')) return dbResult([{state:'awaiting_browser',legState:options.cellularState??'created',ack:null}]);
    if (sql.includes('s.device_id=$1 AND '+expiredWebReservation)) {
      expect(args).toEqual([ids.deviceId,WEB_RESERVATION_SWEEP_PAGE]);
      return dbResult();
    }
    if (sql.startsWith('SELECT 1 FROM call_session s WHERE s.device_id=')) {
      expect(sql).toMatch(/s.state='unknown'[\s\S]+s.kind='web_out'/);
      return options.busy?dbResult([{}]):dbResult();
    }
    if (sql==='SELECT id FROM call_session WHERE id=$1 FOR UPDATE') return dbResult([{}]);
    if (sql.startsWith('SELECT 1 FROM call_session s WHERE s.id=')) return options.staleProof?dbResult():dbResult([{}]);
    if (sql.startsWith('INSERT INTO call_outbound_attempt')) {
      expect(args).toEqual([ids.id,ids.deviceId,ids.callId,cmd,simId]);
      expect(sql).toContain('s.sim_id=$5');
      expect(sql).toContain('AND NOT ('+expiredWebReservation+')');
      expect(sql).toContain('AND '+unarmedWebReservation);
      options.afterArmInsert?.();
      return dbResult([],options.tooLate?0:1);
    }
    if (sql.startsWith("UPDATE call_leg SET state='connected'")) {
      expect(args).toEqual([ids.browserLegId,ids.id]);
      expect(sql).toContain("type='browser' AND state='created'");
      return dbResult([],options.browserMissing?0:1);
    }
    if (sql.startsWith("UPDATE call_leg SET state='ended'")) return dbResult([],args.length===1?2:1);
    if (sql.startsWith('UPDATE call_session') || sql.startsWith('INSERT INTO call_event')) return dbResult([],1);
    throw new Error('Unexpected query: '+sql);
  });
  const client={query, release:vi.fn()};
  return {store:new PgWebCallStore({connect:async()=>client} as unknown as pg.Pool),query};
};

it('excludes expired, previously attempted or mismatched reservations before committing an arm',async()=>{
  const late=storeFixture({tooLate:true});
  expect(await late.store.arm(ids,simId,sim,cmd,()=>true)).toBe(false);
  expect(late.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE call_leg'))).toBe(false);
  expect(late.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE call_session'))).toBe(false);
  const valid=storeFixture();
  await expect(valid.store.arm(ids,simId,sim,cmd,()=>true)).resolves.toBe(true);
  expect(valid.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_session'))?.[1]).toEqual([ids.id,'awaiting_browser','cell_dialing',null]);
  expect(valid.query.mock.calls.at(-1)?.[0]).toBe('COMMIT');
});

it('rolls back the arm if the browser leg or admission changes',async()=>{
  const missing=storeFixture({browserMissing:true});
  await expect(missing.store.arm(ids,simId,sim,cmd,()=>true)).rejects.toThrow('Browser reservation leg changed');
  expect(missing.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
  let owned=true;
  const lost=storeFixture({afterArmInsert:()=>{owned=false;}});
  await expect(lost.store.arm(ids,simId,sim,cmd,()=>owned)).rejects.toThrow('CAPABILITY_UNSUPPORTED');
  expect(lost.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
});

it('closes both pristine legs, but keeps an ambiguous waiting state unknown and busy',async()=>{
  const never=storeFixture();
  expect(await never.store.finish(ids,'browser_cancelled')).toBe(true);
  expect(never.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_leg'))?.[1]).toEqual([ids.id]);
  expect(never.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_session'))?.[1]).toEqual([ids.id,'awaiting_browser','ended',null]);
  const ambiguous=storeFixture({staleProof:true,busy:true});
  expect(await ambiguous.store.finish(ids,'browser_cancelled')).toBe(true);
  expect(ambiguous.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_leg'))?.[1]).toEqual([ids.browserLegId,ids.id]);
  expect(ambiguous.query.mock.calls.find(([sql])=>sql.startsWith('UPDATE call_session'))?.[1]).toEqual([ids.id,'awaiting_browser','unknown','unknown']);
  await expect(ambiguous.store.reserve(ids,{key:'fixture',simId,to:'5550123',peerKind:'short'},()=>true)).rejects.toThrow('DEVICE_BUSY');
  expect(ambiguous.query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO call_session'))).toBe(false);
});

it('compensates a lost reservation reply only on fresh positive proof',async()=>{
  const f=storeFixture({staleProof:true});
  await f.store.compensateReservation(ids,'fixture');
  expect(f.query.mock.calls.find(([sql])=>sql.includes('pg_advisory_xact_lock'))?.[1]).toEqual(['fixture']);
  expect(f.query.mock.calls.find(([sql])=>sql.startsWith('SELECT 1 FROM call_session s WHERE s.id='))?.[1]).toEqual([ids.id,false]);
  expect(f.query.mock.calls.some(([sql])=>sql.startsWith('UPDATE call_leg'))).toBe(false);
});

it('runs the DB-only sweep in the drained production maintenance loop', async()=>{
  const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  expect(source.indexOf('await reconcileCalls(pool, assertAdmission)')).toBeLessThan(source.indexOf('await app.listen('));
  const section=source.slice(source.indexOf('const presence=new TrackedInterval'),source.indexOf('transportLifecycle.defer(()=>presence.stop()'));
  expect(section).toMatch(/webReservations\.sweep\(assertAdmission,[\s\S]+hub\.publishLatest\('call.updated'/);
  expect(section).toContain('calls.summary(sessionId)), stopping');
  expect(source).toContain('transportLifecycle.defer(()=>presence.stop(),{critical:true});');
});
