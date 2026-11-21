import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { migrate } from '../src/db/migrate.js';
import { SettingsConflict, SettingsRepository } from '../src/settings/repo.js';
import { CallReadRepository } from '../src/calls/read-repo.js';
import { SmsCreateRepository } from '../src/sms/create.js';
import { DeviceEvents } from '../src/devices/events.js';

// Explicitly opt in with an empty, dedicated local database. Never drops data.
const databaseUrl = process.env.VOIPGW_TEST_DATABASE_URL;
it.skipIf(!databaseUrl)('migrates and serializes real PostgreSQL operations', async () => {
  const url = new URL(databaseUrl!);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || !/^\/voipgw_test_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Use a loopback PostgreSQL URL with a dedicated voipgw_test_* database and no URL parameters');
  }
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 8, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
  try {
    const identity = await pool.query<{name:string}>('SELECT current_database() AS name');
    if (identity.rows[0]?.name !== decodeURIComponent(url.pathname.slice(1))) throw new Error('Unexpected database');
    const existing = await pool.query<{count:string}>("SELECT count(*)::text AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','S','f')");
    if (existing.rows[0]?.count !== '0') throw new Error('Test database public schema must be empty');
    const dir = resolve('migrations');
    const files = (await readdir(dir)).filter(name => /^\d{4}_.+\.sql$/.test(name)).sort();
    await Promise.all([migrate(pool, dir), migrate(pool, dir)]);
    const versions = await pool.query<{version:number}>('SELECT version FROM schema_migration ORDER BY version');
    expect(versions.rows.map(row => row.version)).toEqual(files.map(name => Number(name.slice(0, 4))));
    await migrate(pool, dir);
    expect(Number((await pool.query('SELECT count(*) AS n FROM schema_migration')).rows[0].n)).toBe(files.length);

    const settings = new SettingsRepository(pool);
    const results = await Promise.allSettled([settings.update({ heartbeatSec: 80 }), settings.update({ offlineAfterSec: 60 })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    const current = await settings.get();
    expect(current.offlineAfterSec).toBeGreaterThan(current.heartbeatSec);
    const conditional = await Promise.allSettled([
      settings.update({ heartbeatSec: 20 }, { heartbeatSec: current.heartbeatSec }),
      settings.update({ heartbeatSec: 21 }, { heartbeatSec: current.heartbeatSec }),
    ]);
    expect(conditional.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    const conflict = conditional.find(result => result.status === 'rejected');
    expect(conflict?.status === 'rejected' && conflict.reason).toBeInstanceOf(SettingsConflict);
    const winner = conditional.find(result => result.status === 'fulfilled');
    expect((await settings.get()).heartbeatSec).toBe(winner?.status === 'fulfilled' && winner.value.after.heartbeatSec);

    await pool.query("INSERT INTO device(id,name,online) VALUES('dev_00000000000000000000000000','test',true)");
    await pool.query("INSERT INTO sim(id,device_id,slot,sub_id,state) VALUES('sim_00000000000000000000000000','dev_00000000000000000000000000',0,1,'ready')");

    // Ordered ULID-shaped identifiers make the intended ties independent of fixture insertion order.
    const sessions = [0, 1, 2, 3].map(n => 'ses_' + String(n).padStart(26, '0'));
    const leg = 'leg_00000000000000000000000000';
    const eventIds = [0, 1, 2].map(n => 'evt_' + String(n).padStart(26, '0'));
    await pool.query(
      `INSERT INTO call_session(id,kind,state,device_id,sim_id,started_at,answered_at)
       VALUES ($1,'web_out','active','dev_00000000000000000000000000','sim_00000000000000000000000000','2026-01-01T00:00:00.123456Z','2026-01-01T00:00:01.654321Z'),
              ($2,'web_out','ended','dev_00000000000000000000000000','sim_00000000000000000000000000','2026-01-01T00:00:00.123456Z',NULL),
              ($3,'web_out','ended','dev_00000000000000000000000000','sim_00000000000000000000000000','2026-01-01T00:00:00.123455Z',NULL),
              ($4,'platform_in','ended','dev_00000000000000000000000000','sim_00000000000000000000000000','2026-01-02T00:00:00Z',NULL)`, sessions,
    );
    await pool.query(`INSERT INTO call_leg(id,session_id,type,state,connected_at)
      VALUES ($1,$2,'cellular','active','2026-01-01T00:00:01.654321Z')`, [leg,sessions[0]]);
    await pool.query(`INSERT INTO call_event(id,session_id,leg_id,event,payload,ts) VALUES
      ($1,$4,$5,'state','{"order":0}','2026-01-01T00:00:00.123456Z'),
      ($2,$4,NULL,'state','{"order":1}','2026-01-01T00:00:00.123456Z'),
      ($3,$4,NULL,'state','{"order":2}','2026-01-01T00:00:00.123457Z')`, [...eventIds,sessions[0],leg]);
    const calls = new CallReadRepository(pool);
    const firstCalls = await calls.list({kind:'web_out',limit:1});
    expect(firstCalls.data.map(row => (row as {id:string}).id)).toEqual([sessions[1]]);
    expect(JSON.parse(Buffer.from(firstCalls.nextCursor!, 'base64url').toString()).time).toBe('2026-01-01 00:00:00.123456+00');
    const secondCalls = await calls.list({kind:'web_out',limit:1,cursor:firstCalls.nextCursor!});
    const thirdCalls = await calls.list({kind:'web_out',limit:1,cursor:secondCalls.nextCursor!});
    expect([...secondCalls.data,...thirdCalls.data].map(row => (row as {id:string}).id)).toEqual([sessions[0],sessions[2]]);
    expect(thirdCalls.nextCursor).toBeNull();

    const summary = await calls.summary(sessions[0]!) as Record<string,unknown>;
    const detail = await calls.detail(sessions[0]!) as Record<string,unknown>;
    expect(summary).not.toHaveProperty('events');
    expect(summary).toMatchObject({id:sessions[0],startedAt:1767225600123,answeredAt:1767225601654,legs:[{id:leg,state:'connected',connectedAt:1767225601654}]});
    expect(detail).toMatchObject(summary);
    expect(detail.events).toMatchObject(eventIds.map((id,order) => ({id,sessionId:sessions[0],payload:{order},ts:1767225600123})));
    expect(await calls.summary('ses_00000000000000000000000009')).toBeNull();
    expect(await calls.detail('ses_00000000000000000000000009')).toBeNull();
    expect(await calls.eventPage('ses_00000000000000000000000009',1)).toBeNull();
    expect(await calls.eventPage(sessions[1]!,1)).toEqual({data:[],nextCursor:null});
    const firstEvents = await calls.eventPage(sessions[0]!,1);
    expect(firstEvents!.data).toEqual([{id:eventIds[0],sessionId:sessions[0],legId:leg,event:'state',ts:1767225600123}]);
    expect(JSON.parse(Buffer.from(firstEvents!.nextCursor!, 'base64url').toString())).toMatchObject({time:'2026-01-01T00:00:00.123456Z',id:eventIds[0]});
    const secondEvents = await calls.eventPage(sessions[0]!,1,firstEvents!.nextCursor!);
    const thirdEvents = await calls.eventPage(sessions[0]!,1,secondEvents!.nextCursor!);
    expect([...secondEvents!.data,...thirdEvents!.data].map(row => (row as {id:string}).id)).toEqual(eventIds.slice(1));
    expect(thirdEvents!.nextCursor).toBeNull();
    await expect(calls.eventPage(sessions[1]!,1,firstEvents!.nextCursor!)).rejects.toThrow('BAD_CURSOR');

    const oversizedIds = ['evt_00000000000000000000000010','evt_00000000000000000000000011'];
    await pool.query(`INSERT INTO call_event(id,session_id,event,ts) VALUES
      ($1,$3,'state','2026-01-02T00:00:00Z'),($2,$3,repeat('x',4097),'2026-01-02T00:00:01Z')`, [...oversizedIds,sessions[3]]);
    const beforeOversized = await calls.eventPage(sessions[3]!,1);
    expect(beforeOversized!.data).toMatchObject([{id:oversizedIds[0]}]);
    expect(beforeOversized!.nextCursor).toBeTruthy();
    await expect(calls.eventPage(sessions[3]!,1,beforeOversized!.nextCursor!)).rejects.toThrow('EVENT_TOO_LARGE');

    const sms = new SmsCreateRepository(pool);
    const creations = await Promise.all(Array.from({length: 8}, () => sms.create('integration-key','sim_00000000000000000000000000','123','hello')));
    expect(creations.every(row => row && !row.conflict)).toBe(true);
    expect(new Set(creations.map(row => (row!.message as {id:string}).id)).size).toBe(1);
    expect((await sms.create('integration-key','sim_00000000000000000000000000','123','different'))?.conflict).toBe(true);
    expect(Number((await pool.query("SELECT count(*) AS n FROM sms_task WHERE idempotency_key='integration-key'")).rows[0].n)).toBe(1);
    expect(Number((await pool.query("SELECT count(*) AS n FROM sms_message WHERE device_id='dev_00000000000000000000000000'")).rows[0].n)).toBe(1);

    const beforeIncoming = Number((await pool.query("SELECT count(*) AS n FROM call_session WHERE device_id='dev_00000000000000000000000000'")).rows[0].n);
    const events = new DeviceEvents(pool);
    const event = {id:'evt_integration', type:'call.incoming', ts:Date.now(), payload:{callId:'call_integration',slot:0,subId:1,from:null,fromKind:'unknown'}};
    const received = await Promise.all([events.handle('dev_00000000000000000000000000', event), events.handle('dev_00000000000000000000000000', event)]);
    expect(received.sort()).toEqual(['duplicate','inserted']);
    expect(Number((await pool.query("SELECT count(*) AS n FROM call_session WHERE device_id='dev_00000000000000000000000000'")).rows[0].n)).toBe(beforeIncoming + 1);
    expect(await events.handle('dev_00000000000000000000000000', {...event,id:'evt_collision'})).toBe('inserted');
    expect(Number((await pool.query("SELECT count(*) AS n FROM call_identity_quarantine WHERE device_id='dev_00000000000000000000000000' AND call_id='call_integration'")).rows[0].n)).toBe(1);
    expect(Number((await pool.query("SELECT count(*) AS n FROM call_reject_intent WHERE device_id='dev_00000000000000000000000000' AND state IN ('pending','sending','accepted')")).rows[0].n)).toBe(0);
  } finally { await pool.end(); }
}, 60000);
