import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {SmsQueueRepository} from '../src/sms/queue-repo.js';
it('expires a bounded locked batch, records provenance and enqueues only CAS winners',async()=>{
 const query=vi.fn(async(sql:string,params?:unknown[])=>{
  if(sql==='COMMIT'||sql==='ROLLBACK')return {command:sql,rows:[],rowCount:0};
  if(sql.startsWith('SELECT t.id'))return {rows:[{id:'one'},{id:'lost'}],rowCount:2};
  if(sql.startsWith("UPDATE sms_task SET state='failed'"))return {rows:[],rowCount:params?.[0]==='one'?1:0};
  return {rows:[],rowCount:0};
 });
 const repo=new SmsQueueRepository({connect:async()=>({query,release(){}})} as unknown as pg.Pool);
 expect(await repo.expire()).toBe(1);
 const selection=query.mock.calls.find(([sql])=>sql.startsWith('SELECT t.id'))![0];
 expect(selection).toContain("t.state='queued'");expect(selection).toContain("24 hours");expect(selection).toContain('SKIP LOCKED LIMIT 100');
 const update=query.mock.calls.find(([sql])=>sql.startsWith('UPDATE sms_task SET state='))!;
 expect(update[0]).toContain('local_failure=true');expect(update[1]).toEqual(['one','DEVICE_OFFLINE']);
 expect(query.mock.calls.filter(([sql])=>sql.startsWith('INSERT INTO sms_maintenance'))).toHaveLength(1);
 expect(query.mock.calls.findIndex(([sql])=>sql.startsWith('INSERT INTO sms_maintenance'))).toBeLessThan(query.mock.calls.findIndex(([sql])=>sql==='COMMIT'));
});

it('moves aged acceptance to unknown, replays confirmed device results and keeps a durable invalidation', async () => {
 const query = vi.fn(async (sql: string, params?: unknown[]) => {
  if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { command: sql, rows: [], rowCount: 0 };
  if (sql.startsWith('SELECT t.id')) return { rows: [{ id: 'task' }, { id: 'changed' }], rowCount: 2 };
  if (sql.startsWith("UPDATE sms_task SET state='unknown',error_code=NULL")) return { rows: [], rowCount: params?.[0] === 'task' ? 1 : 0 };
  if (sql.startsWith('SELECT e.payload')) return { rows: [{ payload: { state: 'sent', errorCode: null } }], rowCount: 1 };
  if (sql.includes("SET state='unknown',error_code='SMS_RESULT_CONFLICT'")) {
   expect(params).toEqual(['task', true, false, false]);
   return { rows: [], rowCount: 0 };
  }
  if (sql.startsWith('UPDATE sms_task SET state=$2')) {
   expect(params).toEqual(['task', 'sent', null]);
   return { rows: [], rowCount: 1 };
  }
  if (sql.startsWith('INSERT INTO sms_maintenance_admin_invalidation')) return { rows: [], rowCount: 1 };
  throw new Error('Unexpected SQL in accepted-task fixture: ' + sql);
 });
 const repo = new SmsQueueRepository({ connect: async () => ({ query, release() {} }) } as unknown as pg.Pool);
 expect(await repo.settleUnconfirmed()).toBe(1);
 const sql = query.mock.calls.map(args => args[0]);
 const selection = sql.find(text => text.startsWith('SELECT t.id'));
 expect(selection).toContain("t.state='accepted' AND t.updated_at<=clock_timestamp()-interval '24 hours'");
 expect(selection).toContain('FOR UPDATE OF t SKIP LOCKED LIMIT 100');
 expect(query.mock.calls).toContainEqual([expect.stringContaining("state IN ('accepted','unknown')"), ['task', 'sent', null]]);
 expect(query.mock.calls.filter(([text]) => text.startsWith('INSERT INTO sms_maintenance'))).toEqual([
  [expect.stringContaining('ON CONFLICT (task_id) DO UPDATE'), ['task']],
 ]);
 expect(sql.at(-1)).toBe('COMMIT');
});
