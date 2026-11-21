import {describe,it,expect} from 'vitest';
import type pg from 'pg';
import {createHash} from 'node:crypto';
import {createExperimentalSessionBoundSmsQuarantineReader} from '../src/db/sms-quarantine-reader.js';

const input={actorId:'admin',mode:'inventory' as const,cursor:null,limit:2};
function fake(missing?:'actor'|'session'|'live', fail?:string) {
 const calls:{sql:string;params?:unknown[]}[]=[];
 const client={query:async(sql:string,params?:unknown[])=>{calls.push({sql,params});if(fail && sql.startsWith(fail))throw Error('secret database detail');
  if(sql==='COMMIT'||sql==='ROLLBACK')return {command:sql,rows:[]};
  if(sql.startsWith('SELECT id FROM admin'))return {rows:missing==='actor'?[]:[{id:'admin'}]};
  if(sql.startsWith('SELECT admin_id FROM admin_session'))return {rows:missing==='session'?[]:[{admin_id:'admin'}]};
  if(sql.startsWith('SELECT 1 FROM admin_session'))return {rows:missing==='live'?[]:[{'?column?':1}]};
  return {rows:[]};},release:()=>{}};
 return {pool:{connect:async()=>client} as unknown as pg.Pool,calls};
}
describe('experimental session-bound quarantine reader',()=>{
 it('locks admin then session, checks wall clock after locking, audits and commits without raw bearer',async()=>{
  const f=fake();expect(await createExperimentalSessionBoundSmsQuarantineReader(f.pool)(input,'bearer-secret')).toEqual([]);
  expect(f.calls.map(c=>c.sql.split(' ')[0])).toEqual(['BEGIN','SELECT','SELECT','SELECT','INSERT','SELECT','COMMIT']);
  expect(f.calls[1]!.sql).toContain('FOR SHARE');expect(f.calls[2]!.sql).toContain('FOR SHARE');expect(f.calls[2]!.sql).not.toContain('expires_at');
  expect(f.calls[3]!.sql).toContain('expires_at>clock_timestamp()');
  expect(f.calls[2]!.params).toEqual([createHash('sha256').update('bearer-secret').digest(),'admin']);
  expect(JSON.stringify(f.calls)).not.toContain('bearer-secret');
 });
 it('rejects absent, mismatched, revoked or expired sessions before audit',async()=>{
  for(const missing of ['actor','session','live'] as const){const f=fake(missing);await expect(createExperimentalSessionBoundSmsQuarantineReader(f.pool)(input,'bearer')).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(f.calls.some(c=>c.sql.startsWith('INSERT'))).toBe(false);expect(f.calls.at(-1)?.sql).toBe('ROLLBACK');}
 });
 it('rejects missing and invalid bearer without database access',async()=>{for(const bearer of [undefined,'', 'x'.repeat(4097)]){const f=fake();await expect(createExperimentalSessionBoundSmsQuarantineReader(f.pool)(input,bearer as string)).rejects.toThrow('QUARANTINE_UNAVAILABLE');expect(f.calls).toEqual([]);}});
 it('masks database and commit errors',async()=>{for(const fail of ['INSERT','COMMIT']){const f=fake(undefined,fail);await expect(createExperimentalSessionBoundSmsQuarantineReader(f.pool)(input,'bearer')).rejects.toThrow(/^QUARANTINE_UNAVAILABLE$/);}});
});
