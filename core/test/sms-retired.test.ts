import {it,expect,vi} from 'vitest';import type pg from 'pg';import {SmsQueueRepository} from '../src/sms/queue-repo.js';
it('fails only queued retired SIM tasks with local failure provenance',async()=>{
 const query=vi.fn(async(sql:string,_params?:unknown[])=>{if(sql==='COMMIT'||sql==='ROLLBACK')return {command:sql,rows:[],rowCount:0};if(sql.startsWith('SELECT t.id'))return {rows:[{id:'t'}],rowCount:1};if(sql.startsWith("UPDATE sms_task SET state='failed'"))return {rows:[],rowCount:1};return {rows:[],rowCount:0};});
 const repo=new SmsQueueRepository({connect:async()=>({query,release(){}})} as unknown as pg.Pool);expect(await repo.failRetired()).toBe(1);
 expect(query.mock.calls.find(([sql])=>sql.startsWith('SELECT t.id'))![0]).toContain('s.retired_at IS NOT NULL');
 expect(query.mock.calls.find(([sql])=>sql.startsWith("UPDATE sms_task SET state='failed'"))![1]).toEqual(['t','SIM_NOT_READY']);
});
