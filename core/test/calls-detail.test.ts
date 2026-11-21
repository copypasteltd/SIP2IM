import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {adminCallSessionDetail} from '@voipgw/protocol';
import {CallReadRepository} from '../src/calls/read-repo.js';
import {createServer,type HttpDeps} from '../src/http/server.js';
import {registerUnavailableControl} from '../src/http/unavailable.js';

const id='ses_00000000000000000000000000';
const row={id,kind:'platform_in',state:'ended',deviceId:'dev_00000000000000000000000000',simId:null,peer:null,peerKind:null,platform:null,startedAt:'1000.125',answeredAt:null,endedAt:'2000.999',endCause:null,promptPlayed:false,earlyMediaForwarded:false,legs:[{id:'leg_00000000000000000000000000',type:'cellular',state:'active',connectedAt:1001.123,endedAt:null,endCause:null},{id:'leg_00000000000000000000000001',type:'browser',state:'new_value',connectedAt:null,endedAt:null,endCause:null}],events:[{id:'evt_any',sessionId:id,legId:null,event:'state',payload:null,ts:1000.999},{id:'evt_2',sessionId:id,legId:'leg_00000000000000000000000000',event:'device',payload:{nested:[1,'two']},ts:'2000.001'}]};

it('returns a complete projected detail from one parameterized read',async()=>{
 const query=vi.fn(async(_sql:string,_args:unknown[])=>({rows:[row]}));
 const repo=new CallReadRepository({query} as unknown as pg.Pool);
 const result=adminCallSessionDetail.parse(await repo.detail(id));
 expect(result.startedAt).toBe(1000);expect(result.endedAt).toBe(2000);
 expect(result.legs.map(l=>l.state)).toEqual(['connected','unknown']);expect(result.legs[0]?.connectedAt).toBe(1001);
 expect(result.events.map(e=>e.ts)).toEqual([1000,2000]);expect(result.events.map(e=>e.payload)).toEqual([null,{nested:[1,'two']}]);
 expect(query).toHaveBeenCalledTimes(1);const [sql,args]=query.mock.calls[0]!;
 expect(args).toEqual([id]);expect(sql).toMatch(/WHERE c.id=\$1/);expect(sql).toMatch(/ORDER BY e.ts,e.id/);expect(sql).not.toMatch(/\bLIMIT\b/i);expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
 expect(adminCallSessionDetail.parse(JSON.parse(JSON.stringify(result)))).toEqual(result);
});
it('rejects invalid event timestamps and handles empty or missing detail',async()=>{
 const query=vi.fn(async():Promise<{rows:Record<string,unknown>[]}>=>({rows:[row]}));const repo=new CallReadRepository({query} as unknown as pg.Pool);
 query.mockResolvedValueOnce({rows:[{...row,events:[]}]});expect((adminCallSessionDetail.parse(await repo.detail(id))).events).toEqual([]);
 query.mockResolvedValueOnce({rows:[]});expect(await repo.detail(id)).toBeNull();
 for(const ts of [null,'',-1,'NaN',8640000000000001]){query.mockResolvedValueOnce({rows:[{...row,events:[{...row.events[0]!,ts}]}]});await expect(repo.detail(id)).rejects.toThrow('INVALID_CALL_TIMESTAMP');}
});
it('authenticates and validates before lookup and leaves control routes intact',async()=>{
 const query=vi.fn(async(_sql:string,args:unknown[])=>({rows:args[0]===id?[row]:[]}));const repo=new CallReadRepository({query} as unknown as pg.Pool);
 const deps={authenticate:async(t:string)=>t==='ok'?'admin':null,callDetail:(value:string)=>repo.detail(value),listCalls:async()=>({data:[],nextCursor:null})} as unknown as HttpDeps;
 const app=createServer(deps);registerUnavailableControl(app,deps.authenticate);
 try{
  const headers={authorization:'Bearer ok'};
  expect((await app.inject({method:'GET',url:'/api/calls/bad'})).statusCode).toBe(401);
  expect((await app.inject({method:'GET',url:'/api/calls/'+id,headers:{authorization:'Bearer bad'}})).statusCode).toBe(401);
  for(const bad of ['bad','ses_80000000000000000000000000','ses_0000000000000000000000000I',encodeURIComponent("' OR 1=1--"), '%00']) expect((await app.inject({method:'GET',url:'/api/calls/'+bad,headers})).statusCode).toBe(400);
  expect(query).not.toHaveBeenCalled();
  const found=await app.inject({method:'GET',url:'/api/calls/'+id,headers});expect(found.statusCode).toBe(200);expect(found.headers['cache-control']).toBe('no-store');expect(adminCallSessionDetail.parse(found.json().data).events).toHaveLength(2);
  const missing=await app.inject({method:'GET',url:'/api/calls/ses_00000000000000000000000001',headers});expect(missing.statusCode).toBe(404);expect(missing.json().error.code).toBe('NOT_FOUND');
  expect((await app.inject({method:'GET',url:'/api/calls',headers})).statusCode).toBe(200);
  for(const action of ['hangup','dtmf'])expect((await app.inject({method:'POST',url:'/api/calls/'+id+'/'+action,headers})).statusCode).toBe(409);
  expect(query).toHaveBeenCalledTimes(2);
  query.mockRejectedValueOnce(new Error('sensitive database failure'));const failure=await app.inject({method:'GET',url:'/api/calls/'+id,headers});expect(failure.statusCode).toBe(500);expect(failure.json().error.code).toBe('INTERNAL');expect(failure.body).not.toContain('sensitive database failure');
 }finally{await app.close();}
});
