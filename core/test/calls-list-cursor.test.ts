import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {CallReadRepository} from '../src/calls/read-repo.js';
import {createServer,type HttpDeps} from '../src/http/server.js';
const encode=(value:unknown)=>Buffer.from(JSON.stringify(value)).toString('base64url');
const row=(id:string,cursorTime:string)=>({id,cursorTime,startedAt:'1767225600123',answeredAt:null,endedAt:null,legs:[]});
it('round trips exact microseconds and uses DateStyle-independent output',async()=>{
 const time='2026-01-01 00:00:00.123456+00';const query=vi.fn().mockResolvedValueOnce({rows:[row('legacy id/é',time),row('next',time)]}).mockResolvedValueOnce({rows:[]});
 const repo=new CallReadRepository({query} as unknown as pg.Pool);const page=await repo.list({limit:1});await repo.list({limit:1,cursor:page.nextCursor!});
 expect(query.mock.calls[1]![1].slice(3,5)).toEqual([time,'legacy id/é']);expect(query.mock.calls[0]![0]).toContain("AT TIME ZONE 'UTC'");
});
it('fails explicitly instead of emitting a cursor the decoder would reject',async()=>{
 const time='2026-01-01 00:00:00.123456+00';
 for(const item of [row('x'.repeat(101),time),row('bad\0id',time),row('id','2026-02-30 00:00:00+00')]){
  const query=vi.fn().mockResolvedValue({rows:[item,row('next',time)]});
  await expect(new CallReadRepository({query} as unknown as pg.Pool).list({limit:1})).rejects.toThrow('INVALID_CALL_CURSOR');
 }
});
it('never emits a cursor exceeding the HTTP limit',async()=>{
 const time='2026-01-01 00:00:00.123456+00';
 for(const [id,status] of [['legacy/é',200],['\x01'.repeat(100),200]] as const){
  const query=vi.fn().mockResolvedValueOnce({rows:[row(id,time),row('next',time)]}).mockResolvedValueOnce({rows:[]});
  const repo=new CallReadRepository({query} as unknown as pg.Pool);
  const app=createServer({authenticate:async()=> 'admin',listCalls:(filters:Parameters<typeof repo.list>[0])=>repo.list(filters)} as unknown as HttpDeps);
  try {const first=await app.inject({url:'/api/calls?limit=1',headers:{authorization:'Bearer ok'}});expect(first.statusCode).toBe(status);
   if(status===200){const cursor=first.json().nextCursor as string;expect(cursor.length).toBeLessThanOrEqual(2048);if(id.length===100)expect(cursor.length).toBeGreaterThan(512);const next=await app.inject({url:'/api/calls?limit=1&cursor='+cursor,headers:{authorization:'Bearer ok'}});expect(next.statusCode).toBe(200);}
  } finally {await app.close();}
 }
});
it('accepts old ISO PostgreSQL and UTC cursors without changing their values',async()=>{
 const query=vi.fn().mockResolvedValue({rows:[]});const repo=new CallReadRepository({query} as unknown as pg.Pool);
 for(const time of ['2026-01-01 12:34:56.123456+05:30','2026-01-01T12:34:56.123456Z','0004-02-29 00:00:00+00','0100-02-28 00:00:00+00']){await repo.list({limit:1,cursor:encode({time,id:''})});expect(query.mock.lastCall![1][3]).toBe(time);}
});
it('rejects invalid timestamps, unsafe IDs, and malformed cursor encodings before querying',async()=>{
 const query=vi.fn();const repo=new CallReadRepository({query} as unknown as pg.Pool);const time='2026-01-01 00:00:00+00';
 const badTimes=['2026-02-30 00:00:00+00','0000-01-01 00:00:00+00','0001-02-29 00:00:00+00','0100-02-29 00:00:00+00','2026-01-01','2026-01-01T00:00:00.1234567Z','2026-01-01 00:00:00+16','2026-01-01 00:00:00+00\0','   4-02-29 00:00:00+00'];
 const valid=encode({time,id:'x'});const bad=['', '!', valid+'=',valid+'!', 'A'.repeat(2049),...badTimes.map(time=>encode({time,id:'x'})),encode({time,id:'x\0'}),encode({time,id:'x'.repeat(101)}),encode(null),encode([])];
 for(const cursor of bad)await expect(repo.list({limit:1,cursor})).rejects.toThrow('BAD_CURSOR');expect(query).not.toHaveBeenCalled();
});
