// Opt-in only: empty loopback database voipgw_quarantine_test_run3. No server
// or credentials are provided; test objects and data remain in that database.
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {experimentalQuarantineSms} from '../src/db/sms-quarantine-writer-experimental.js';
import {createSmsQuarantineReader} from '../src/db/sms-quarantine-reader.js';

const url=process.env.VOIPGW_QUARANTINE_ROUNDTRIP_TEST_DATABASE_URL;
const enabled=process.env.VOIPGW_QUARANTINE_ROUNDTRIP_TEST_ENABLE==='yes' && !!url;
const event={v:1,type:'sms.received',id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1700000000000,payload:{subId:null,slot:null,from:'peer',fromKind:'unknown',body:'\u0000\ud800',receivedAt:1700000000000,parts:1}};

describe.skipIf(!enabled)('experimental PostgreSQL writer-to-reader roundtrip',()=>{
 it('lists, exports bytes, audits missing exports, and rolls back audit failures',async()=>{
  const u=new URL(url!);
  if (!['postgres:','postgresql:'].includes(u.protocol) || !['127.0.0.1','[::1]'].includes(u.hostname) || u.pathname!=='/voipgw_quarantine_test_run3' || u.search || u.hash) throw Error('Dedicated empty local test database required');
  const pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:3000,query_timeout:10000,statement_timeout:10000,options:'-c search_path=public,pg_catalog'});
  try {
   const db=await pool.query('SELECT current_database() AS name, current_schema() AS schema');
   if(db.rows[0]?.name!==u.pathname.slice(1) || db.rows[0]?.schema!=='public') throw Error('Wrong test database or schema');
   const objects=await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' LIMIT 1");
   if(objects.rows.length) throw Error('Test database must have an empty public schema');
   await pool.query(await readFile(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
   await pool.query(await readFile(new URL('../experimental/sms-quarantine-prototype.sql',import.meta.url),'utf8'));
   await pool.query("INSERT INTO device(id,name) VALUES ('dev1','test'); INSERT INTO admin(id,username,password_hash) VALUES ('admin1','test','unused')");
   expect(await experimentalQuarantineSms(pool,'dev1',event)).toBe('inserted');
   const read=createSmsQuarantineReader(pool);
   const rows=await read({actorId:'admin1',mode:'inventory',cursor:null,limit:2});
   expect(rows).toHaveLength(1);
   expect(rows[0]).toMatchObject({deviceId:'dev1',eventId:event.id,reason:'postgres-invalid-string',encoding:'json-utf16le-v1'});
   expect(rows[0]).not.toHaveProperty('payload');
   const id=rows[0]!.id;
   // Independently construct the canonical JSON bytes, not from database or writer.
   const expected=Buffer.from(JSON.stringify(event),'utf16le');
   const exported=await read({actorId:'admin1',mode:'export',id,cursor:null,limit:1});
   expect(exported).toHaveLength(1);
   expect(exported[0]!.payload).toEqual(expected);
   expect(exported[0]!.payloadLength).toBe(expected.length);
   const missing='00000000-0000-4000-8000-000000000001';
   expect(await read({actorId:'admin1',mode:'export',id:missing,cursor:null,limit:1})).toEqual([]);
   const cursor={time:rows[0]!.createdAt,id};
   expect(await read({actorId:'admin1',mode:'inventory',cursor,limit:1})).toEqual([]);
   const audits=await pool.query('SELECT actor_id,mode,record_id::text,cursor_time IS NOT NULL AS has_cursor_time,cursor_id::text,page_limit FROM sms_quarantine_access_audit ORDER BY id');
   expect(audits.rows).toEqual([
    {actor_id:'admin1',mode:'inventory',record_id:null,has_cursor_time:false,cursor_id:null,page_limit:2},
    {actor_id:'admin1',mode:'export',record_id:id,has_cursor_time:false,cursor_id:null,page_limit:1},
    {actor_id:'admin1',mode:'export',record_id:missing,has_cursor_time:false,cursor_id:null,page_limit:1},
    {actor_id:'admin1',mode:'inventory',record_id:null,has_cursor_time:true,cursor_id:id,page_limit:1},
   ]);
   await pool.query("CREATE FUNCTION quarantine_audit_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER quarantine_audit_test_fail AFTER INSERT ON sms_quarantine_access_audit FOR EACH ROW EXECUTE FUNCTION quarantine_audit_test_fail()");
   await expect(read({actorId:'admin1',mode:'export',id,cursor:null,limit:1})).rejects.toThrow('QUARANTINE_UNAVAILABLE');
   expect((await pool.query('SELECT count(*)::int AS count FROM sms_quarantine_access_audit')).rows[0].count).toBe(4);
   await pool.query('DROP TRIGGER quarantine_audit_test_fail ON sms_quarantine_access_audit; DROP FUNCTION quarantine_audit_test_fail()');
   expect((await read({actorId:'admin1',mode:'export',id,cursor:null,limit:1}))[0]!.payload).toEqual(expected);
  } finally {await pool.end();}
 },30000);
});
