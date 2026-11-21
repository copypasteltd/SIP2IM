import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {replaySmsResults} from '../src/sms/results.js';
import {SmsRepository} from '../src/sms/repo.js';

it.each([['sent','failed'],['failed','sent'],['delivered','failed']])('keeps conflicting %s and %s evidence unknown',async(a,b)=>{
 const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT e.payload')) return {rows:[a,b].map(state=>({payload:{state,errorCode:null}}))};
  if(sql.includes("SET state='unknown',error_code='SMS_RESULT_CONFLICT'")) {
   expect(args).toEqual(['task',true,true,false]);
   expect(sql).toContain("state IN ('accepted','unknown','failed','sent','delivered')");
   expect(sql).toContain("$2::boolean AND (state='failed' OR $3::boolean)");
   return {rows:[],rowCount:1};
  }
  if(sql.startsWith('INSERT INTO sms_maintenance_admin_invalidation')) return {rows:[],rowCount:1};
  throw new Error('Mixed terminal evidence must not enter ordinary projection: '+sql);
 });
 await replaySmsResults({query} as unknown as pg.PoolClient,'task');
 const statements=query.mock.calls.map(([sql])=>sql);
 expect(statements.filter(sql=>sql.startsWith('UPDATE sms_task'))).toHaveLength(1);
 expect(statements.filter(sql=>sql.startsWith('INSERT INTO sms_maintenance_admin_invalidation'))).toHaveLength(1);
 expect(statements.at(-1)).toContain('ON CONFLICT (task_id) DO UPDATE');
});
it.each(['sent','failed'])('reconciles dispatched rows and replays acknowledged %s in one transaction',async(result)=>{
 const sql:string[]=[];
 const query=vi.fn(async(statement:string)=>{sql.push(statement);if(statement==='COMMIT'||statement==='ROLLBACK')return {rowCount:0,rows:[],command:statement};if(statement.startsWith('UPDATE sms_task') && statement.includes('RETURNING id'))return {rowCount:1,rows:[{id:'task'}]};if(statement.startsWith('SELECT e.payload'))return {rows:[{payload:{state:result,errorCode:null}}]};if(statement.includes("error_code='SMS_RESULT_CONFLICT'"))return {rowCount:0,rows:[]};return {rowCount:1,rows:[]};});
 const release=vi.fn(); const pool={connect:async()=>({query,release})} as unknown as pg.Pool;
 expect(await new SmsRepository(pool).reconcile()).toBe(1);
 expect(sql[0]).toBe('BEGIN'); expect(sql[1]).toContain("state='dispatched' RETURNING id");
 expect(sql[2]).toContain('SELECT e.payload'); expect(sql[3]).toContain("error_code='SMS_RESULT_CONFLICT'"); expect(sql[4]).toContain('UPDATE sms_task SET state=$2'); expect(sql.at(-1)).toBe('COMMIT'); expect(release).toHaveBeenCalledOnce();
});
it('rolls back reconciliation if replay fails',async()=>{
 const sql:string[]=[];const query=vi.fn(async(statement:string)=>{sql.push(statement);if(statement==='COMMIT'||statement==='ROLLBACK')return {rowCount:0,rows:[],command:statement};if(statement.includes('RETURNING id'))return {rowCount:1,rows:[{id:'task'}]};if(statement.startsWith('SELECT e.payload'))throw Error('read failed');return {rows:[]};});
 const release=vi.fn(); const pool={connect:async()=>({query,release})} as unknown as pg.Pool;
 await expect(new SmsRepository(pool).reconcile()).rejects.toThrow('read failed');expect(sql.at(-1)).toBe('ROLLBACK');expect(release).toHaveBeenCalledOnce();
});
