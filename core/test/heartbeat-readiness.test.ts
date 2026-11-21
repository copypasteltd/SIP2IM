import {describe,it,expect,vi} from 'vitest';
import {canCall,canCommand,fresh,isOnline,observation} from '../src/devices/status.js';
import {DashboardService} from '../src/dashboard/service.js';
import {DashboardRepository} from '../src/dashboard/repo.js';
import type pg from 'pg';

const now=1_000_000;
const heartbeat=(value:string)=>observation(value,now,'heartbeat');
const base={online:true,enabled:true,paused:false,callEnabled:true,capabilityLevel:'L4',network:heartbeat('wifi'),shizuku:heartbeat('running'),downlink:observation('ok',now,'probes'),uplink:observation('ok',now,'probes')};
describe('unknown heartbeat readiness',()=>{
  it('does not treat future observations as fresh',()=>{
    expect(fresh(observation('wifi',now+1,'heartbeat'),now)).toBeUndefined();
  });
  it('keeps a live device commandable but not callable for either unknown field',()=>{
    expect(isOnline(now,now+30_000,90)).toBe(true);
    for(const level of ['L3','L4']) for(const incoming of [false,true]) for(const field of ['network','shizuku'] as const){
      const device={...base,capabilityLevel:level,[field]:heartbeat('unknown')};
      expect(canCommand(device)).toBeNull();
      expect(canCall(device,'ready',now,incoming)).toBe(false);
    }
    expect(canCall(base,'ready',now,true)).toBe(true);
    expect(canCall({...base,network:heartbeat('none')},'ready',now)).toBe(false);
    expect(canCall(base,'ready',now+90_001)).toBe(false);
    expect(canCall({...base,capabilityLevel:'L3',shizuku:heartbeat('unsupported')},'ready',now)).toBe(true);
  });
  it('counts online and SMS readiness independently from unknown call readiness',async()=>{
    const status=(deviceId:string,field:string,value:unknown)=>({deviceId,field,value,observedAt:new Date(now),receivedAt:new Date(now),ttlSec:90});
    const devices=['network-unknown','shizuku-unknown','ready'].map(id=>({id,online:true,enabled:true,paused:false,callEnabled:true,capabilityLevel:'L4',inCall:false}));
    const statuses=devices.flatMap(({id})=>[status(id,'network',id==='network-unknown'?'unknown':'wifi'),status(id,'shizuku',id==='shizuku-unknown'?'unknown':'running'),status(id,'probe.downlink',{result:'ok'}),status(id,'probe.uplink',{result:'ok'}),status(id,'permissions',[{name:'SEND_SMS',granted:true},{name:'RECEIVE_SMS',granted:true}])]);
    const snapshot={devices,sims:devices.map(({id})=>({deviceId:id,state:'ready',lastSeenAt:new Date(now),numberKnown:false,needsReview:false})),statuses,channels:[],alerts:{open:0,critical:0}};
    const result=await new DashboardService({snapshot:async()=>snapshot},()=>now).get();
    expect(result.devices).toMatchObject({total:3,online:3,offline:0});
    expect(result.sims).toMatchObject({total:3,ready:3});
    expect(result.capability).toEqual({smsReady:3,callReady:1,inCall:0});
  });
  it('requests network observations in the dashboard snapshot',async()=>{
    const query=vi.fn(async (_sql:string)=>({rows:[]}));
    await new DashboardRepository({query} as unknown as pg.Pool).snapshot();
    expect(query.mock.calls.some(([sql])=>typeof sql==='string' && sql.includes("'network'") && sql.includes('device_status'))).toBe(true);
  });
});
