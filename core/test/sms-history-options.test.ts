import {expect,it,vi} from 'vitest';
import type pg from 'pg';
import {SmsHistoryOptions} from '../src/sms/history-options.js';
import {createServer,type HttpDeps} from '../src/http/server.js';

it('limits SMS-backed historical options with stable id cursors and parameterized search',async()=>{
  const query=vi.fn().mockResolvedValueOnce({rows:[{id:'a',name:'Old',revoked:true},{id:'b'}]}).mockResolvedValueOnce({rows:[{id:'b',name:'Other',revoked:false}]}).mockResolvedValueOnce({rows:[{id:'s1',deviceId:'a',slot:0,carrier:'Old carrier',number:null,retired:true,deviceRevoked:true}]});
  const repo=new SmsHistoryOptions({query} as unknown as pg.Pool);
  const first=await repo.devices({q:"x%'",limit:1});
  expect(first.data).toEqual([{id:'a',name:'Old',revoked:true}]);
  expect(first.nextCursor).toBeTruthy();
  await repo.devices({limit:1,cursor:first.nextCursor!});
  expect(query.mock.calls[0]![0]).toContain('EXISTS (SELECT 1 FROM sms_message');
  expect(query.mock.calls[0]![0]).not.toContain("x%'");
  expect(query.mock.calls[0]![1]).toEqual(["x%'",null,2]);
  expect(query.mock.calls[1]![1]).toEqual([null,'a',2]);
  const sims=await repo.sims({deviceId:'a',limit:10});
  expect(sims.data[0]).toMatchObject({retired:true,deviceRevoked:true});
  expect(query.mock.calls[2]![0]).toContain('m.device_id=s.device_id');
  expect(query.mock.calls[2]![1]).toEqual([null,null,11,'a']);
  await expect(repo.devices({limit:1,cursor:'!!!!'})).rejects.toThrow('BAD_CURSOR');
});

it('requires authentication and validates historical lookup inputs before querying',async()=>{
  const historyDevices=vi.fn(async()=>({data:[{id:'a',name:'Old',revoked:true}],nextCursor:null}));
  const historySims=vi.fn(async()=>{throw new Error('BAD_CURSOR');});
  const app=createServer({authenticate:async(token:string)=>token==='valid'?'admin':null,historyDevices,historySims} as unknown as HttpDeps);
  try {
    expect((await app.inject({url:'/api/sms/history/devices'})).statusCode).toBe(401);
    expect(historyDevices).not.toHaveBeenCalled();
    const headers={authorization:'Bearer valid'};
    expect((await app.inject({url:'/api/sms/history/devices?limit=201',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/sms/history/devices?unexpected=x',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/sms/history/devices?q=a%00b',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/sms/history/sims?q=a%00b',headers})).statusCode).toBe(400);
    expect((await app.inject({url:'/api/sms/history/sims?deviceId=a%00b',headers})).statusCode).toBe(400);
    expect(historyDevices).not.toHaveBeenCalled();
    expect(historySims).not.toHaveBeenCalled();
    const response=await app.inject({url:'/api/sms/history/devices?q=Old&limit=1',headers});
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual([{id:'a',name:'Old',revoked:true}]);
    expect((await app.inject({url:'/api/sms/history/sims?cursor=bad',headers})).statusCode).toBe(400);
  } finally {await app.close();}
});
