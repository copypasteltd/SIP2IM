import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {SmsQueueRepository} from '../src/sms/queue-repo.js';
it('uses server-observed freshness and preserves unknown separately from unavailable',async()=>{
 const query=vi.fn(async(_sql:string,_args?:unknown[])=>({rowCount:1,rows:[{state:'unknown'}]}));
 const repo=new SmsQueueRepository({query} as unknown as pg.Pool);
 expect(await repo.simState('s','d')).toBe('unknown');
 expect(query.mock.calls[0]?.[0]).toContain("last_seen_at < now()-interval '2 hours'");
 expect(query.mock.calls[0]?.[1]).toEqual(['s','d']);
});
