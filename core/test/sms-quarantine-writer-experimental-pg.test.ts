// Explicit opt-in only. Requires a disposable, EMPTY database named
// voipgw_quarantine_test or voipgw_quarantine_test_<lowercase alphanumerics>;
// no server is started and no credentials are supplied.
// It leaves test objects and data in the disposable database; it does not clean up.
import {describe,it,expect} from 'vitest';
import pg from 'pg';
import {readFile} from 'node:fs/promises';
import {experimentalQuarantineSms} from '../src/db/sms-quarantine-writer-experimental.js';

const url=process.env.VOIPGW_QUARANTINE_TEST_DATABASE_URL;
const enabled=process.env.VOIPGW_QUARANTINE_TEST_ENABLE==='yes' && !!url;
const event={v:1,type:'sms.received',id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1700000000000,payload:{subId:null,slot:null,from:'peer',fromKind:'unknown',body:'\u0000\ud800',receivedAt:1700000000000,parts:1}};
describe.skipIf(!enabled)('experimental isolated PostgreSQL quarantine',()=>{
 it('serializes conflicts and atomically rolls back and retries',async()=>{
  const u=new URL(url!);
  if (!['postgres:','postgresql:'].includes(u.protocol) || !['127.0.0.1','[::1]'].includes(u.hostname) || !/^\/voipgw_quarantine_test(?:_[a-z0-9]+)?$/.test(u.pathname) || u.search || u.hash) throw Error('Dedicated empty local test database required');
  const pool=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:3000,query_timeout:10000,statement_timeout:10000,options:'-c search_path=public,pg_catalog'});
  try {
   const db=await pool.query('SELECT current_database() AS name, current_schema() AS schema');
   if(db.rows[0]?.name!==u.pathname.slice(1) || db.rows[0]?.schema!=='public') throw Error('Wrong test database or schema');
   const objects=await pool.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' LIMIT 1");
   if(objects.rows.length) throw Error('Test database must have an empty public schema');
   await pool.query(await readFile(new URL('../migrations/0001_init.sql',import.meta.url),'utf8'));
   await pool.query(await readFile(new URL('../experimental/sms-quarantine-prototype.sql',import.meta.url),'utf8'));
   await pool.query("INSERT INTO device(id,name) VALUES ('dev1','test'),('dev2','test')");
   const legacy={...event,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAX'};
   await pool.query("INSERT INTO device_event(id,device_id,type,payload,device_ts) VALUES ($1,'dev1','sms.result','{}'::jsonb,$2)",[legacy.id,new Date(legacy.ts)]);
   expect(await experimentalQuarantineSms(pool,'dev1',legacy)).toBe('rejected');
   // Hold an uncommitted unique parent key, then observe the actual competitor
   // waiting on this transaction before resolving it. Different devices avoid the
   // writer's device-row FOR UPDATE lock being mistaken for the unique-key wait.
   const contend=async (id:string, resolution:'COMMIT'|'ROLLBACK')=>{
    const held=await pool.connect();
    const competitorPool=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:3000,query_timeout:10000,statement_timeout:10000,options:'-c search_path=public,pg_catalog'});
    let active=false;
    let competitor:Promise<{result?:string;error?:unknown}>|undefined;
    try {
     await held.query('BEGIN'); active=true;
     const holderPid=(await held.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
     await held.query("INSERT INTO device_event(id,device_id,type,payload,device_ts) VALUES ($1,'dev1','sms.received','{}'::jsonb,$2)",[id,new Date(event.ts)]);
     const competitorPid=(await competitorPool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
     competitor=experimentalQuarantineSms(competitorPool,'dev2',{...event,id}).then(result=>({result}),error=>({error}));
     const deadline=Date.now()+5000;
     let waiting=false;
     while(Date.now()<deadline) {
      const observed=await pool.query(
       `SELECT 1 FROM pg_stat_activity a JOIN pg_locks l ON l.pid=a.pid
        WHERE a.pid=$1 AND a.wait_event_type='Lock' AND l.locktype='transactionid'
          AND NOT l.granted AND $2=ANY(pg_blocking_pids(a.pid))
          AND a.query LIKE 'INSERT INTO device_event%'`,[competitorPid,holderPid]);
      if(observed.rows.length===1) {waiting=true; break;}
      await new Promise(resolve=>setTimeout(resolve,25));
     }
     expect(waiting,'competitor must wait on the holder transaction at the parent insert').toBe(true);
     await held.query(resolution); active=false;
     const outcome=await competitor;
     if(outcome.error) throw outcome.error;
     return outcome.result;
    } finally {
     if(active) await held.query('ROLLBACK');
     held.release();
     // Drain the writer before closing its pool, including on assertion failure.
     if(competitor) await competitor;
     await competitorPool.end();
    }
   };
   const committedId='evt_01ARZ3NDEKTSV4RRFFQ69G5FAY';
   expect(await contend(committedId,'COMMIT')).toBe('rejected');
   const committed=await pool.query("SELECT device_id,custody_kind FROM device_event WHERE id=$1",[committedId]);
   expect(committed.rows).toEqual([{device_id:'dev1',custody_kind:'normal'}]);
   const committedChildren=await pool.query('SELECT (SELECT count(*)::int FROM sms_quarantine_record WHERE event_id=$1) AS children,(SELECT count(*)::int FROM sms_quarantine_alert WHERE event_id=$1) AS alerts',[committedId]);
   expect(committedChildren.rows[0]).toEqual({children:0,alerts:0});
   const rolledBackId='evt_01ARZ3NDEKTSV4RRFFQ69G5FAZ';
   expect(await contend(rolledBackId,'ROLLBACK')).toBe('inserted');
   const rolledBack=await pool.query("SELECT p.device_id,p.custody_kind,q.device_id AS child_device_id,a.event_id AS alert_id FROM device_event p JOIN sms_quarantine_record q ON q.event_id=p.id JOIN sms_quarantine_alert a ON a.event_id=p.id WHERE p.id=$1",[rolledBackId]);
   expect(rolledBack.rows).toEqual([{device_id:'dev2',custody_kind:'sms_quarantine',child_device_id:'dev2',alert_id:rolledBackId}]);
   const outcomes=await Promise.all([experimentalQuarantineSms(pool,'dev1',event),experimentalQuarantineSms(pool,'dev2',event)]);
   expect(outcomes.sort()).toEqual(['inserted','rejected']);
   const parent=await pool.query('SELECT device_id FROM device_event WHERE id=$1',[event.id]);
   const winner=parent.rows[0].device_id as string;
   expect(await experimentalQuarantineSms(pool,winner,event)).toBe('duplicate');
   expect(await experimentalQuarantineSms(pool,winner,{...event,ts:event.ts+1})).toBe('rejected');
   const rollbackEvent={...event,id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW'};
   await pool.query("CREATE FUNCTION quarantine_test_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$; CREATE TRIGGER quarantine_test_fail BEFORE INSERT ON sms_quarantine_alert FOR EACH ROW EXECUTE FUNCTION quarantine_test_fail()");
   await expect(experimentalQuarantineSms(pool,winner,rollbackEvent)).rejects.toThrow('EXPERIMENTAL_QUARANTINE_UNAVAILABLE');
   const absent=await pool.query('SELECT 1 FROM device_event WHERE id=$1',[rollbackEvent.id]);
   expect(absent.rows).toHaveLength(0);
   await pool.query('DROP TRIGGER quarantine_test_fail ON sms_quarantine_alert; DROP FUNCTION quarantine_test_fail()');
   expect(await experimentalQuarantineSms(pool,winner,rollbackEvent)).toBe('inserted');
   const count=await pool.query('SELECT (SELECT count(*)::int FROM sms_quarantine_record) AS children,(SELECT count(*)::int FROM sms_quarantine_alert) AS alerts');
   expect(count.rows[0]).toEqual({children:3,alerts:3});
  } finally {await pool.end();}
 },60000);
});
