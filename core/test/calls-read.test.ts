import {it,expect,vi} from 'vitest';import type pg from 'pg';import {adminCallSession, cellCallState} from '@voipgw/protocol';import {CallReadRepository} from '../src/calls/read-repo.js';

it('projects database leg states into the real admin schema without inferring outcomes',async()=>{
 const expected:Record<string,string>={ringing:'ringing',dialing:'dialing',alerting:'unknown',active:'connected',disconnected:'ended',created:'created',connected:'connected',ended:'ended',failed:'failed',unknown:'unknown',future_state:'unknown',toString:'unknown'};
 expect(Object.keys(expected)).toEqual(expect.arrayContaining(cellCallState.options));
 const legs=Object.keys(expected).map((state,i)=>({id:`leg_0${String(i).padStart(25,'0')}`,type:'cellular',state,connectedAt:i===3?'1000.123':null,endedAt:i===4?2000.456:null,endCause:i===4?'busy':null}));
 const row={id:'ses_00000000000000000000000000',cursorTime:'2026-01-01 00:00:00.123456+00',kind:'platform_in',state:'ended',deviceId:'dev_00000000000000000000000000',simId:null,peer:null,peerKind:null,platform:null,startedAt:'1000.123',answeredAt:'1001.999',endedAt:null,endCause:null,promptPlayed:false,earlyMediaForwarded:false,legs};
 const query=vi.fn(async()=>({rows:[row]}));
 const page=await new CallReadRepository({query} as unknown as pg.Pool).list({limit:10});
 const parsed=adminCallSession.parse(page.data[0]);
 expect(parsed.legs.map(leg=>leg.state)).toEqual(Object.values(expected));
 expect(parsed.legs[3]?.connectedAt).toBe(1000);expect(parsed.legs[4]?.endedAt).toBe(2000);expect(parsed.legs[4]?.endCause).toBe('busy');
 expect(parsed.startedAt).toBe(1000);expect(parsed.answeredAt).toBe(1001);expect(parsed.endedAt).toBeNull();
 expect(adminCallSession.parse(JSON.parse(JSON.stringify(page.data[0])))).toEqual(parsed);
 query.mockResolvedValueOnce({rows:[{...row,startedAt:null as unknown as string}]});await expect(new CallReadRepository({query} as unknown as pg.Pool).list({limit:10})).rejects.toThrow('INVALID_CALL_TIMESTAMP');
 for(const bad of ['', '8640000000000001', '-1', 'NaN']){
  for(const field of ['startedAt','answeredAt','endedAt']){query.mockResolvedValueOnce({rows:[{...row,[field]:bad}]});await expect(new CallReadRepository({query} as unknown as pg.Pool).list({limit:10})).rejects.toThrow('INVALID_CALL_TIMESTAMP');}
  query.mockResolvedValueOnce({rows:[{...row,legs:[{...legs[0]!,connectedAt:bad}]}]});await expect(new CallReadRepository({query} as unknown as pg.Pool).list({limit:10})).rejects.toThrow('INVALID_CALL_TIMESTAMP');
 }
});
it('filters and pages call history without initiating calls',async()=>{const query=vi.fn(async(_sql:string,_args:unknown[])=>({rows:[{id:'s',cursorTime:'2026-01-01 00:00:00.123456+00',startedAt:'1000',answeredAt:null,endedAt:null,legs:[]},{id:'t',startedAt:'900',answeredAt:null,endedAt:null,legs:[]}]}));const repo=new CallReadRepository({query} as unknown as pg.Pool);const page=await repo.list({limit:1,deviceId:'d',active:true});expect(page.data).toHaveLength(1);expect(page.nextCursor).toBeTruthy();expect(query.mock.calls[0]![1].slice(0,3)).toEqual([null,'d',true]);});
