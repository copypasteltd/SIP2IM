// EXPERIMENTAL: opt in only against a separate, empty loopback database.
// Creates test objects and leaves them in place. Never use a service database.
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createExperimentalSessionBoundSmsQuarantineReader} from '../src/db/sms-quarantine-reader.js';
const url=process.env.VOIPGW_QUARANTINE_SESSION_TEST_DATABASE_URL;
const enabled=process.env.VOIPGW_QUARANTINE_SESSION_TEST_ENABLE==='yes' && !!url;
const hash=(s:string)=>createHash('sha256').update(s).digest();
const input={actorId:'admin1',mode:'inventory' as const,cursor:null,limit:2};
describe.skipIf(!enabled)('experimental session-bound reader with PostgreSQL',()=>{
 it('revalidates expiry and deletion, serializes logout and rolls back audit failures',async()=>{
  const u=new URL(url!);
  if(!['postgres:','postgresql:'].includes(u.protocol)||!['127.0.0.1','[::1]'].includes(u.hostname)||u.pathname!=='/voipgw_quarantine_session_test' || u.search || u.hash)throw Error('Dedicated empty local test database required');
  const pool=new pg.Pool({connectionString:url,max:5,connectionTimeoutMillis:3000,statement_timeout:5000,query_timeout:7000,options:'-c search_path=public,pg_catalog'});
  try {
   const db=await pool.query('SELECT current_database() AS name,current_schema() AS schema');
   if(db.rows[0]?.name!=='voipgw_quarantine_session_test'||db.rows[0]?.schema!=='public')throw Error('Wrong test database or schema');
   const objects=await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' LIMIT 1");
   if(objects.rows.length)throw Error('Test database must have an empty public schema');
   await pool.query(await readFile(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
   await pool.query(await readFile(new URL('../experimental/sms-quarantine-prototype.sql',import.meta.url),'utf8'));
   await pool.query("INSERT INTO admin(id,username,password_hash) VALUES ('admin1','test','unused'),('admin2','other','unused')");
   await pool.query("INSERT INTO admin_session(token_hash,admin_id,expires_at) VALUES ($1,'admin1',clock_timestamp()+interval '1 hour'),($2,'admin2',clock_timestamp()+interval '1 hour'),($3,'admin1',clock_timestamp()-interval '1 second')",[hash('valid'),hash('other'),hash('expired')]);
   const read=createExperimentalSessionBoundSmsQuarantineReader(pool);
   expect(await read(input,'valid')).toEqual([]);
   for(const token of ['missing','other','expired'])await expect(read(input,token)).rejects.toThrow('QUARANTINE_UNAVAILABLE');
   expect((await pool.query('SELECT count(*)::int AS n FROM sms_quarantine_access_audit')).rows[0].n).toBe(1);
   // Observe an actual reader blocked by the holder; never infer ordering from timing.
   const holder=await pool.connect();
   const holderPid=(await holder.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
   let readerPid=0;
   const observed={connect:async()=>{const c=await pool.connect();readerPid=(await c.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;return c;}} as unknown as pg.Pool;
   const waitBlocked=async()=>{for(let n=0;n<100;n++){if(readerPid && (await pool.query('SELECT $1::int=ANY(pg_blocking_pids($2::int)) AS blocked',[holderPid,readerPid])).rows[0].blocked)return;await new Promise(r=>setTimeout(r,20));}throw Error('Reader did not block on session lock');};
   try {
    await pool.query("UPDATE admin_session SET expires_at=clock_timestamp()+interval '1 second' WHERE token_hash=$1",[hash('valid')]);
    await holder.query('BEGIN');await holder.query('SELECT 1 FROM admin_session WHERE token_hash=$1 FOR UPDATE',[hash('valid')]);
    const pending=createExperimentalSessionBoundSmsQuarantineReader(observed)(input,'valid');
    const outcome=pending.then(()=>false,()=>true);
    try {await waitBlocked();await holder.query('SELECT pg_sleep(1.1)');await holder.query('COMMIT');expect(await outcome).toBe(true);} finally {await holder.query('ROLLBACK');await outcome;}
    await pool.query("UPDATE admin_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1",[hash('valid')]);
    await holder.query('BEGIN');await holder.query('DELETE FROM admin_session WHERE token_hash=$1',[hash('valid')]);
    readerPid=0;
    const deleted=createExperimentalSessionBoundSmsQuarantineReader(observed)(input,'valid').then(()=>false,()=>true);
    try {await waitBlocked();await holder.query('COMMIT');expect(await deleted).toBe(true);} finally {await holder.query('ROLLBACK');await deleted;}
   } finally {holder.release();}
   await pool.query("INSERT INTO admin_session(token_hash,admin_id,expires_at) VALUES ($1,'admin1',clock_timestamp()+interval '1 hour')",[hash('valid')]);
   await pool.query("UPDATE admin_session SET expires_at=clock_timestamp()+interval '1 hour' WHERE token_hash=$1",[hash('valid')]);
   // Pause at audit insertion after both reader locks and expiry check.
   let reached!:()=>void, resume!:()=>void;
   const atAudit=new Promise<void>(r=>{reached=r;});const gate=new Promise<void>(r=>{resume=r;});
   const wrapped={connect:async()=>{const c=await pool.connect();return {query:async(sql:string,params?:unknown[])=>{if(sql.startsWith('INSERT INTO sms_quarantine_access_audit')){reached();await gate;}return c.query(sql,params);},release:(v?:boolean)=>c.release(v)};}} as unknown as pg.Pool;
   const active=createExperimentalSessionBoundSmsQuarantineReader(wrapped)(input,'valid');
   const settled=active.then(rows=>({rows}),error=>({error}));
   try {
    await Promise.race([atAudit,settled.then(()=>{throw Error('Reader finished before audit barrier');}),new Promise<never>((_,reject)=>setTimeout(()=>reject(Error('Audit barrier timed out')),5000))]);
    const logout=await pool.connect();
    try {await logout.query('BEGIN');await logout.query("SET LOCAL lock_timeout='250ms'");await expect(logout.query('DELETE FROM admin_session WHERE token_hash=$1',[hash('valid')])).rejects.toMatchObject({code:'55P03'});await logout.query('ROLLBACK');} finally {logout.release();}
   } finally {resume();}
   expect(await settled).toEqual({rows:[]});
   await pool.query('DELETE FROM admin_session WHERE token_hash=$1',[hash('valid')]);
   await expect(read(input,'valid')).rejects.toThrow('QUARANTINE_UNAVAILABLE');
   expect((await pool.query('SELECT count(*)::int AS n FROM sms_quarantine_access_audit')).rows[0].n).toBe(2);
   await pool.query("INSERT INTO admin_session(token_hash,admin_id,expires_at) VALUES ($1,'admin1',clock_timestamp()+interval '1 hour')",[hash('valid')]);
   await pool.query("CREATE FUNCTION quarantine_session_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER quarantine_session_fail AFTER INSERT ON sms_quarantine_access_audit FOR EACH ROW EXECUTE FUNCTION quarantine_session_fail()");
   await expect(read(input,'valid')).rejects.toThrow('QUARANTINE_UNAVAILABLE');
   expect((await pool.query('SELECT count(*)::int AS n FROM sms_quarantine_access_audit')).rows[0].n).toBe(2);
  } finally {await pool.end();}
 },30000);
});
