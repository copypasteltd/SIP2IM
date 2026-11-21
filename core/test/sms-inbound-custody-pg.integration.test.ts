import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseDeviceMessage} from '@voipgw/protocol';
import pg from 'pg';
import {expect,it} from 'vitest';
import {tokenHash} from '../src/auth/service.js';
import {migrate} from '../src/db/migrate.js';
import {assertSmsCustodyReady} from '../src/db/sms-quarantine-custody.js';
import {createRecoverableSmsQuarantineReader} from '../src/db/sms-quarantine-reader.js';
import {DeviceEvents} from '../src/devices/events.js';
import {decodeQuarantinePayload} from '../src/devices/sms-quarantine-codec.js';

// Opt in only with an approved, empty, dedicated PostgreSQL database. Leaves the test records intact.
const enabled=process.env.VOIPGW_ENABLE_ISOLATED_SMS_CUSTODY_PG_TEST === '1';
it.skipIf(!enabled)('verifies inbound custody and session-bound recovery on isolated PostgreSQL',async () => {
  const value=process.env.VOIPGW_SMS_CUSTODY_TEST_DATABASE_URL;
  if (!value) throw Error('Dedicated SMS custody test database URL is required');
  const url=new URL(value);
  if (!['postgres:','postgresql:'].includes(url.protocol) || !['127.0.0.1','[::1]'].includes(url.hostname) ||
      !url.port || !/^\/voipgw_test_sms_custody_[a-z0-9_]+$/.test(url.pathname) || url.search || url.hash) {
    throw Error('A dedicated loopback voipgw_test_sms_custody_* database and explicit port are required');
  }
  const pool=new pg.Pool({connectionString:value,max:4,connectionTimeoutMillis:5000,statement_timeout:10000});
  try {
    const identity=await pool.query<{name:string;schema:string;objects:string}>(
      "SELECT current_database() AS name,current_schema() AS schema,(SELECT count(*)::text FROM pg_class WHERE relnamespace='public'::regnamespace) AS objects");
    expect(identity.rows[0]).toEqual({name:url.pathname.slice(1),schema:'public',objects:'0'});
    await migrate(pool,fileURLToPath(new URL('../migrations/',import.meta.url)));
    await assertSmsCustodyReady(pool);
    const sender='dev_00000000000000000000000001';
    const other='dev_00000000000000000000000002';
    const actor='adm_00000000000000000000000001';
    const bearer=randomBytes(32).toString('base64url');
    await pool.query('INSERT INTO device(id,name) VALUES ($1,$3),($2,$3)',[sender,other,'fixture']);
    await pool.query('INSERT INTO admin(id,username,password_hash) VALUES ($1,$2,$3)',[actor,'fixture','unused']);
    await pool.query("INSERT INTO admin_session(token_hash,admin_id,expires_at) VALUES ($1,$2,clock_timestamp()+interval '1 minute')",[tokenHash(bearer),actor]);
    const ordinary=parseDeviceMessage({v:1,type:'sms.received',id:'evt_00000000000000000000000001',ts:42,
      payload:{subId:null,slot:null,from:'fixture',fromKind:'unknown',body:'fixture',receivedAt:37,parts:1}},'event');
    // The fixture exercises an int4 boundary using the handler directly, without a network device.
    const exceptional=parseDeviceMessage({...ordinary,id:'evt_00000000000000000000000002',
      payload:{...ordinary.payload,parts:2 ** 31}},'event');
    const normal=new DeviceEvents(pool);
    const custody=new DeviceEvents(pool,{smsCustody:'acknowledge'});
    expect(await normal.handle(sender,ordinary)).toBe('inserted');
    expect(await normal.handle(sender,ordinary)).toBe('duplicate');
    expect(await normal.handle(sender,exceptional)).toBe('rejected');
    expect(await Promise.all([custody.handle(sender,exceptional),custody.handle(sender,exceptional)]))
      .toEqual(['quarantined','quarantined']);
    expect(await custody.handle(other,exceptional)).toBe('rejected');
    expect(await custody.handle(sender,{...ordinary,id:exceptional.id})).toBe('rejected');
    expect(await custody.handle(sender,{...exceptional,ts:43})).toBe('rejected');

    const count=await pool.query('SELECT (SELECT count(*)::int FROM sms_message) AS history,'+
      '(SELECT count(*)::int FROM sms_incoming_admin_outbox) AS outbox,'+
      '(SELECT count(*)::int FROM sms_received_quarantine) AS custody');
    expect(count.rows).toEqual([{history:1,outbox:1,custody:1}]);
    const reader=createRecoverableSmsQuarantineReader(pool);
    const page=await reader({actorId:actor,mode:'inventory',limit:2,cursor:null},bearer);
    expect(page.status).toBe('ok');
    if (page.status!=='ok') throw Error('Expected custody metadata');
    expect(page.rows).toHaveLength(1);
    const record=page.rows[0]!;
    expect(record).toMatchObject({deviceId:sender,deviceTs:42,eventId:exceptional.id,state:'retained'});
    expect(record.payload).toBeUndefined();
    const exported=await reader({actorId:actor,mode:'export',limit:1,cursor:null,id:record.id},bearer);
    expect(exported.status).toBe('ok');
    if (exported.status!=='ok') throw Error('Expected custody bytes');
    expect(decodeQuarantinePayload(exported.rows[0]!.payload!)).toEqual(exceptional);
    expect((await pool.query('SELECT mode,outcome FROM sms_received_quarantine_access ORDER BY id')).rows)
      .toEqual([{mode:'inventory',outcome:'ok'},{mode:'export',outcome:'ok'}]);
  } finally { await pool.end(); }
},30000);
