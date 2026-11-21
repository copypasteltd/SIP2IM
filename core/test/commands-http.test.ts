import {describe,it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import {registerOperations} from '../src/http/operations.js';
import {adminOutboundRequest} from '../../packages/protocol/src/admin.js';

const ids=['req_01ARZ3NDEKTSV4RRFFQ69G5FAV','req_01ARZ3NDEKTSV4RRFFQ69G5FAW','req_01ARZ3NDEKTSV4RRFFQ69G5FAX'];
const records = [
  {id:ids[2],kind:'call',platform:'qq',cursorTime:'2026-01-01 00:00:00.123456+00',createdAt:1767225600123,pairedUserId:'u',rawText:'call',fromNumber:null,fromSimId:null,toNumber:'123',toKind:'short',body:null,state:'received',rejectCode:null,sessionId:null,smsTaskId:null},
  {id:ids[1],kind:'call',platform:'qq',cursorTime:'2026-01-01 00:00:00.123456+00',createdAt:1767225600123,pairedUserId:'u',rawText:'call',fromNumber:null,fromSimId:null,toNumber:'123',toKind:'short',body:null,state:'failed',rejectCode:'FAIL',sessionId:null,smsTaskId:null},
  {id:ids[0],kind:'sms',platform:'telegram',cursorTime:'2026-01-01 00:00:00.123123+00',createdAt:1767225600123,pairedUserId:'u',rawText:'sms',fromNumber:null,fromSimId:null,toNumber:'123',toKind:'short',body:'hello',state:'queued',rejectCode:null,sessionId:null,smsTaskId:'tsk'},
];
function setup(){
  const query=vi.fn(async (_sql:string,params:unknown[])=>{
    const [platform,kind,time,id,limit]=params;
    return {rows:records.filter(r=>(!platform||r.platform===platform)&&(!kind||r.kind===kind)&&(!time||r.cursorTime<(time as string)||(r.cursorTime===time&&r.id!<(id as string)))).slice(0,limit as number)};
  });
  const app=Fastify();registerOperations(app,{query} as unknown as pg.Pool,async token=>token==='ok'?'admin':null);
  const get=(url:string,authorization='Bearer ok')=>app.inject({method:'GET',url,headers:{authorization}});
  return {app,query,get};
}
describe('GET /api/commands',()=>{
  it('authenticates first, validates filters, bounds, and cursor without querying',async()=>{
    const {app,query,get}=setup();try{
      expect((await get('/api/commands?limit=bad','Bearer nope')).statusCode).toBe(401);
      for(const queryString of ['limit=0','limit=201','limit=1.5','limit=','limit=1&limit=2','platform=other','kind=other','extra=x','cursor=','cursor=broken','cursor=eyJ0aW1lIjoiMjAyNi0wMi0zMCAwMDowMDowMCswMCIsImlkIjoicmVxXzAxQVJaM05ERUtUU1Y0UlJGRlE2OUc1RkFWIn0']) {
        expect((await get('/api/commands?'+queryString)).statusCode,queryString).toBe(400);
      }
      expect(query).not.toHaveBeenCalled();
    }finally{await app.close();}
  });
  it('filters and paginates equal timestamps without losing microseconds or inventing replies',async()=>{
    const {app,query,get}=setup();try{
      const first=await get('/api/commands?platform=qq&kind=call&limit=1');expect(first.statusCode).toBe(200);
      const page=first.json();expect(page.data).toHaveLength(1);expect(page.data[0]).toEqual({...records[0],cursorTime:undefined});
      expect(page.data[0]).not.toHaveProperty('replies');expect(page.data[0]).not.toHaveProperty('cursorTime');
      expect(adminOutboundRequest.safeParse(page.data[0]).success).toBe(true);
      expect(adminOutboundRequest.safeParse({...page.data[0],createdAt:1.5}).success).toBe(false);
      expect(adminOutboundRequest.safeParse({...page.data[0],replies:[{text:'reply',ts:1}]}).success).toBe(true);
      expect(page.nextCursor).toBeTruthy();
      const second=(await get('/api/commands?platform=qq&kind=call&limit=1&cursor='+page.nextCursor)).json();
      expect(second.data.map((r:{id:string})=>r.id)).toEqual([ids[1]]);expect(second.nextCursor).toBeNull();
      expect(query.mock.calls[1]![1]).toEqual(['qq','call','2026-01-01 00:00:00.123456+00',ids[2],2]);
      expect(query.mock.calls[0]![0]).toContain("to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00'");
      expect(query.mock.calls[0]![0]).toContain('floor(extract(epoch from created_at)*1000)::double precision');
      expect(Number.isSafeInteger(page.data[0].createdAt)).toBe(true);
      expect(query.mock.calls[0]![0]).toContain('ORDER BY created_at DESC,id DESC');
      expect(query.mock.calls[0]![0]).toContain('(created_at,id)<($3::timestamptz,$4::text)');
      expect((await get('/api/commands?platform=telegram')).json().data.map((r:{id:string})=>r.id)).toEqual([ids[0]]);
    }finally{await app.close();}
  });
});
