import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {readFile} from 'node:fs/promises';
import {replaySmsResults} from '../src/sms/results.js';
it.each(['sent','delivered'])('makes a legacy failure unknown with %s evidence and preserves it on replay',async(evidence)=>{
 let state='failed',code:string|null=null;const query=vi.fn(async(sql:string,args?:unknown[])=>{
  if(sql.startsWith('SELECT e.payload'))return {rows:[{payload:{state:evidence,errorCode:null}}]};
  if(sql.includes('legacy_failure AND')){if(args?.[1]===true){state='unknown';code='SMS_RESULT_CONFLICT';}return {rowCount:1,rows:[]};}
  if(sql.startsWith('UPDATE sms_task SET state=$2')&&code!=='SMS_RESULT_CONFLICT')state=String(args![1]);
  return {rowCount:0,rows:[]};
 });const client={query} as unknown as pg.PoolClient;
 await replaySmsResults(client,'task');await replaySmsResults(client,'task');expect(state).toBe('unknown');expect(code).toBe('SMS_RESULT_CONFLICT');
});
it('backfills legacy failures and reconciles already stored positive evidence',async()=>{
 const sql=await readFile('migrations/0015_sms_ack_provenance.sql','utf8');
 expect(sql).toContain("SET legacy_failure=true WHERE state='failed'");expect(sql).toContain("m.device_id=e.device_id");expect(sql).toContain("IN ('sent','delivered')");
});
