import {describe,it,expect,vi} from 'vitest';
import Fastify from 'fastify';
import {DashboardService} from '../src/dashboard/service.js';
import {registerDashboardRoute} from '../src/dashboard/routes.js';
import {DashboardRepository, type DashboardSnapshot, type DashboardStatus} from '../src/dashboard/repo.js';

const now=10_000_000;
const snapshot:DashboardSnapshot={
 devices:[{id:'a',online:true,enabled:true,paused:false,callEnabled:true,capabilityLevel:'L4',inCall:true},{id:'b',online:false,enabled:true,paused:true,callEnabled:true,capabilityLevel:'L3',inCall:false}],
 sims:[{deviceId:'a',state:'ready',lastSeenAt:new Date(now),numberKnown:true,needsReview:false},{deviceId:'a',state:'locked',lastSeenAt:new Date(now),numberKnown:false,needsReview:true},{deviceId:'b',state:'ready',lastSeenAt:new Date(now),numberKnown:false,needsReview:false}],
 statuses:[{deviceId:'a',field:'network',value:'wifi',observedAt:new Date(now),receivedAt:new Date(now),ttlSec:10},{deviceId:'a',field:'permissions',value:[{name:'android.permission.SEND_SMS',granted:true},{name:'android.permission.RECEIVE_SMS',granted:true}],observedAt:new Date(now),receivedAt:new Date(now),ttlSec:10},{deviceId:'a',field:'shizuku',value:'running',observedAt:new Date(now),receivedAt:new Date(now),ttlSec:10},...['downlink','uplink'].map(field=>({deviceId:'a',field:'probe.'+field,value:{result:'ok'},observedAt:new Date(now),receivedAt:new Date(now),ttlSec:10}))],
 channels:[{platform:'qq',state:'logged_in',paired:true,voiceVerified:false,busy:true,isInbound:true}],alerts:{open:2,critical:1}
};
describe('dashboard',()=>{
 it('counts devices, SIMs and capability using fresh observations',async()=>{const service=new DashboardService({snapshot:async()=>snapshot},()=>now);expect(await service.get()).toEqual({devices:{total:2,online:1,offline:1,paused:1,byLevel:{L1:0,L2:0,L3:1,L4:1,L5:0}},sims:{total:3,ready:2,numberKnown:1,needsReview:1},capability:{smsReady:1,callReady:1,inCall:1},channels:snapshot.channels,alerts:snapshot.alerts});});
 it('does not treat expired observations as ready',async()=>{const service=new DashboardService({snapshot:async()=>snapshot},()=>now+10001);expect((await service.get()).capability).toEqual({smsReady:0,callReady:0,inCall:1});});
 it('ignores future probes and historically poisoned probes even after their timestamp passes',async()=>{for(const [observed,received] of [[now+1,now],[now-1,now-2],[now-1,now-300002],[-1,-1]] as [number,number][]){const poisoned={...snapshot,statuses:snapshot.statuses.map(s=>s.field==='probe.downlink'?{...s,observedAt:new Date(observed),receivedAt:new Date(received),ttlSec:999999}:s)};expect((await new DashboardService({snapshot:async()=>poisoned},()=>now).get()).capability.callReady).toBe(0);}});
 it('keeps a formerly future heartbeat stale after its clock catches up',async()=>{const poisoned={...snapshot,statuses:snapshot.statuses.map(s=>s.field==='network'?{...s,observedAt:new Date(now-1),receivedAt:new Date(now-2),ttlSec:999999}:s)};expect((await new DashboardService({snapshot:async()=>poisoned},()=>now).get()).capability.callReady).toBe(0);});
 it('counts only SIM observations within the two-hour window',async()=>{for(const [at,expected] of [[now,1],[now-7200000,1],[now-7200001,0],[now+1,0],[-1,0],[null,0]] as [number|null,number][]){const copy={...snapshot,sims:[{...snapshot.sims[0]!,lastSeenAt:at===null?null:new Date(at)}]};const result=await new DashboardService({snapshot:async()=>copy},()=>now).get();expect(result.sims.ready).toBe(expected);expect(result.capability.callReady).toBe(expected);}});
 it('treats a missing SIM observation as unknown',async()=>{const {lastSeenAt:_,...sim}=snapshot.sims[0]!;const result=await new DashboardService({snapshot:async()=>({...snapshot,sims:[sim]})},()=>now).get();expect(result.sims.ready).toBe(0);expect(result.capability.callReady).toBe(0);});
 it('rejects future and historically poisoned permission observations',async()=>{for(const [at,received] of [[now+1,now+1],[now-1,now-2],[-1,now],[NaN,now]] as [number,number][]){const copy={...snapshot,statuses:snapshot.statuses.map(s=>s.field==='permissions'?{...s,observedAt:new Date(at),receivedAt:new Date(received),ttlSec:999999}:s)};expect((await new DashboardService({snapshot:async()=>copy},()=>now).get()).capability.smsReady).toBe(0);}});
 const send = {name:'SEND_SMS',granted:true};
 const receive = {name:'android.permission.RECEIVE_SMS',granted:true};
 const getWithPermissions = (value: unknown,
   overrides: Partial<Pick<DashboardStatus,'observedAt'|'receivedAt'|'ttlSec'>> = {}, readAt = now) =>
   new DashboardService({snapshot:async()=>({...snapshot,statuses:snapshot.statuses.map(s=>
     s.field==='permissions' ? {...s,value,...overrides} : s)})},()=>readAt).get();

 it.each([
   {case:'contradictory SEND_SMS aliases', value:[send,{name:'android.permission.SEND_SMS',granted:false},receive]},
   {case:'contradictory RECEIVE_SMS aliases', value:[send,{name:'RECEIVE_SMS',granted:false},receive]},
   {case:'non-boolean SEND_SMS duplicate', value:[send,{name:'SEND_SMS',granted:'true'},receive]},
   {case:'missing-grant RECEIVE_SMS duplicate', value:[send,receive,{name:'RECEIVE_SMS'}]},
 ])('does not count SMS readiness with $case',async ({value})=>{
   expect((await getWithPermissions(value)).capability).toEqual({smsReady:0,callReady:1,inCall:1});
 });

 it('counts consistent aliases and ignores unrelated malformed entries',async ()=>{
   const value = [send,{name:'android.permission.SEND_SMS',granted:true},receive,null,{name:'READ_SMS'}];
   expect((await getWithPermissions(value)).capability).toEqual({smsReady:1,callReady:1,inCall:1});
 });

 it.each([
   {case:'future receipt', overrides:{receivedAt:new Date(now+1)}},
   {case:'invalid receipt', overrides:{receivedAt:new Date(NaN)}},
   {case:'zero TTL', overrides:{ttlSec:0}},
   {case:'fractional TTL', overrides:{ttlSec:1.5}},
   {case:'infinite TTL', overrides:{ttlSec:Infinity}},
   {case:'unsafe integer TTL', overrides:{ttlSec:Number.MAX_SAFE_INTEGER+1}},
 ])('does not count positive permission evidence with $case',async ({overrides})=>{
   expect((await getWithPermissions([send,receive],overrides)).capability.smsReady).toBe(0);
 });

 it('includes the TTL boundary and never extends permission freshness past one day',async ()=>{
   expect((await getWithPermissions([send,receive],{ttlSec:1},now+1_000)).capability.smsReady).toBe(1);
   expect((await getWithPermissions([send,receive],{ttlSec:1},now+1_001)).capability.smsReady).toBe(0);
   expect((await getWithPermissions([send,receive],{ttlSec:172_800},now+86_400_000)).capability.smsReady).toBe(1);
   expect((await getWithPermissions([send,receive],{ttlSec:172_800},now+86_400_001)).capability.smsReady).toBe(0);
 });
 it('loads the SIM observation timestamp through the repository',async()=>{const query=vi.fn(async(sql:string)=>({rows:sql.includes('FROM sim s JOIN device')?[{...snapshot.sims[0]}]:sql.includes('FROM device d WHERE')?snapshot.devices:sql.includes('FROM device_status')?snapshot.statuses:sql.includes('FROM channel')?snapshot.channels:[snapshot.alerts]}));const repo=new DashboardRepository({query} as never);const result=await new DashboardService(repo,()=>now).get();expect(query.mock.calls.some(([sql])=>sql.includes('s.last_seen_at AS "lastSeenAt"'))).toBe(true);expect(result.sims.ready).toBe(1);expect(result.capability.callReady).toBe(1);});
 it('authenticates before loading data',async()=>{const app=Fastify();const get=vi.fn(async()=>snapshot);registerDashboardRoute(app,{get} as unknown as DashboardService,async t=>t==='valid'?'admin':null);expect((await app.inject({method:'GET',url:'/api/dashboard'})).statusCode).toBe(401);expect(get).not.toHaveBeenCalled();const response=await app.inject({method:'GET',url:'/api/dashboard',headers:{authorization:'Bearer valid'}});expect(response.json()).toEqual(JSON.parse(JSON.stringify({data:snapshot})));await app.close();});
});
