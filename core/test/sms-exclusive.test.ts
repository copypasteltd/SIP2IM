import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {SmsHistory,type SmsFilters} from '../src/sms/history.js';
import {createServer,type HttpDeps} from '../src/http/server.js';

it('combines the exclusive upper bound with inclusive to and preserves cursor parameters',async()=>{
  const query=vi.fn(async(sql:string,values:unknown[])=>{
    expect(sql).toContain("m.occurred_at < $5::timestamptz + interval '1 millisecond'");
    expect(sql).toContain('m.occurred_at < $9');
    expect(sql).toContain('(m.occurred_at,m.id)<($6,$7)');
    const times=[999,1000,1000.456,1001];
    const to=values[4] as Date|null, exclusive=values[8] as Date|null;
    return {rows:times.filter(t=>(!to||t<to.getTime()+1)&&(!exclusive||t<exclusive.getTime())).map(t=>({id:String(t),occurredAt:String(t)}))};
  });
  const history=new SmsHistory({query} as unknown as pg.Pool);
  const ids=async(filters:{to?:number;toExclusive?:number})=>(await history.list({...filters,limit:10})).data.map(row=>(row as {id:string}).id);
  expect(await ids({})).toEqual(['999','1000','1000.456','1001']);
  expect(query.mock.calls[0]![1][8]).toBeNull();
  expect(await ids({to:1000})).toEqual(['999','1000','1000.456']);
  expect(await ids({toExclusive:1000})).toEqual(['999']);
  expect(await ids({to:1000,toExclusive:1001})).toEqual(['999','1000','1000.456']);
  const cursor=Buffer.from(JSON.stringify({time:'2026-01-01T00:00:00.123456Z',id:'id'})).toString('base64url');
  await history.list({cursor,toExclusive:0,limit:10});
  expect(query.mock.calls[4]![1].slice(5)).toEqual(['2026-01-01T00:00:00.123456Z','id',11,new Date(0)]);
});

it('validates and forwards optional toExclusive milliseconds at the SMS route',async()=>{
  const listSms=vi.fn(async(_filters:SmsFilters)=>({data:[],nextCursor:null}));
  const app=createServer({authenticate:async(token:string)=>token==='ok'?'admin':null,listSms} as unknown as HttpDeps);
  const request=(url:string,authorized=true)=>app.inject({method:'GET',url,headers:authorized?{authorization:'Bearer ok'}:{}});
  try {
    expect((await request('/api/sms?toExclusive=1',false)).statusCode).toBe(401);
    expect((await request('/api/sms')).statusCode).toBe(200);
    expect(listSms.mock.calls[0]![0]).toEqual({limit:50});
    expect((await request('/api/sms?from=0&to=1000&toExclusive=1001&limit=5')).statusCode).toBe(200);
    expect(listSms.mock.calls[1]![0]).toEqual({from:0,to:1000,toExclusive:1001,limit:5});
    for(const value of ['-1','8640000000000001','1.5','NaN','Infinity']) {
      const result=await request('/api/sms?toExclusive='+value);
      expect(result.statusCode).toBe(400);
      expect(result.json().error.code).toBe('BAD_REQUEST');
    }
    expect((await request('/api/sms?toExclusive=0')).statusCode).toBe(200);
    expect((await request('/api/sms?toExclusive=8640000000000000')).statusCode).toBe(200);
    expect(listSms).toHaveBeenCalledTimes(4);
  } finally {await app.close();}
});
