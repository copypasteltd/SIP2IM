import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {SmsIdempotencyRepository} from '../src/sms/idempotency.js';
import {createServer,type HttpDeps} from '../src/http/server.js';
import {registerAudit} from '../src/http/audit.js';

it('uses one parameterized read and formats committed messages, or returns null',async()=>{
 const row={id:'m',deviceId:'d',simId:'s',peer:'123',peerKind:'short',body:'hello',parts:1,occurredAt:'42',taskId:'t',state:'unknown',errorCode:null,origin:'admin',updatedAt:'43'};
 const query=vi.fn().mockResolvedValueOnce({rows:[row]}).mockResolvedValueOnce({rows:[]});
 const repo=new SmsIdempotencyRepository({query} as unknown as pg.Pool);
 expect(await repo.find("key'1")).toEqual({id:'m',deviceId:'d',simId:'s',direction:'out',peer:'123',peerKind:'short',body:'hello',parts:1,occurredAt:42,task:{id:'t',state:'unknown',errorCode:null,origin:'admin',updatedAt:43}});
 expect(await repo.find('absent')).toBeNull();
 for(const [sql,params] of query.mock.calls){expect(sql).toMatch(/^SELECT /);expect(sql).toContain("WHERE t.idempotency_key=$1 AND t.origin='admin' AND m.direction='out'");expect(sql).not.toContain("key'1");expect(params).toHaveLength(1);expect(sql).not.toMatch(/\bFOR UPDATE\b|\badvisory\b|\bINSERT\b|\bUPDATE\b|\bDELETE\b/i);}
 expect(query.mock.calls[0]![1]).toEqual(["key'1"]);
});

it('authenticates and validates before lookup without dispatch or audit',async()=>{
 const message={id:'m',task:{id:'t',state:'unknown'}};
 const inspectSmsIdempotency=vi.fn().mockResolvedValueOnce(message).mockResolvedValueOnce(null);
 const createSms=vi.fn();const audit=vi.fn();
 const app=createServer({authenticate:async(t:string)=>t==='valid'?'admin':null,inspectSmsIdempotency,createSms} as unknown as HttpDeps);
 registerAudit(app,audit,()=>{});
 try{
  expect((await app.inject({url:'/api/sms/idempotency'})).statusCode).toBe(401);
  const authorization='Bearer valid';
  const missing=await app.inject({url:'/api/sms/idempotency',headers:{authorization}});
  expect(missing.statusCode).toBe(400);expect(missing.json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
  expect((await app.inject({url:'/api/sms/idempotency',headers:{authorization,'idempotency-key':' '.repeat(3)}})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/sms/idempotency',headers:{authorization,'idempotency-key':'a'.repeat(257)}})).statusCode).toBe(400);
  expect((await app.inject({url:'/api/sms/idempotency?key=secret',headers:{authorization,'idempotency-key':'secret'}})).statusCode).toBe(400);
  expect(inspectSmsIdempotency).not.toHaveBeenCalled();
  const found=await app.inject({url:'/api/sms/idempotency',headers:{authorization,'idempotency-key':'secret'}});
  expect(found.statusCode).toBe(200);expect(found.headers['cache-control']).toBe('no-store');expect(found.json()).toEqual({data:message});
  const absent=await app.inject({url:'/api/sms/idempotency',headers:{authorization,'idempotency-key':'absent'}});
  expect(absent.json()).toEqual({data:null});expect(inspectSmsIdempotency.mock.calls).toEqual([['secret'],['absent']]);
  expect(createSms).not.toHaveBeenCalled();expect(audit).not.toHaveBeenCalled();
 }finally{await app.close();}
});
