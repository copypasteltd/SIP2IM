import {afterEach, expect, it, vi} from 'vitest';
import type pg from 'pg';
import {adminDeviceDetail} from '@voipgw/protocol';
import {DeviceAdminRepository} from '../src/devices/admin-repo.js';
import {DeviceDetailRepository} from '../src/devices/detail-repo.js';

const deviceId='dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const simId='sim_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const now=1_700_000_000_000;
afterEach(()=>vi.restoreAllMocks());

it('selects only the requested active device and produces protocol-valid detail',async()=>{
  vi.spyOn(Date,'now').mockReturnValue(now);
  const query=vi.fn(async(sql:string,params:unknown[])=>{
    if(sql.startsWith('SELECT d.id')) {
      expect(sql).toContain('d.revoked_at IS NULL');
      expect(sql).toContain('d.id=$6');
      expect(sql).toContain('floor(extract(epoch from s.last_seen_at)*1000)');
      expect(sql).toContain('floor(extract(epoch from d.last_seen_at)*1000)');
      expect(params).toEqual([null,null,null,null,2,deviceId]);
      return {rows:[{id:deviceId,cursorTime:'2023-11-14',name:'Phone',enabled:true,paused:false,callEnabled:true,online:true,lastSeenAt:'1699999999123',manufacturer:null,model:null,apiLevel:null,capabilityLevel:null,apkVersion:null,defaultSimId:simId,inCall:false,sims:[{id:simId,deviceId,slot:0,subId:null,carrier:null,state:'ready',number:null,numberKind:'unknown',numberSource:null,needsReview:false,lastSeenAt:1699999999123}]}]};
    }
    if(sql.includes('device_id=ANY')) {
      expect(params[0]).toEqual([deviceId]);
      expect(sql).toContain('received_at');
      return {rows:[{device_id:deviceId,field:'battery',value:42,observed_at:new Date(now-1000),received_at:new Date(now),ttl_sec:2},{device_id:deviceId,field:'charging',value:true,observed_at:new Date(now-5000),received_at:new Date(now),ttl_sec:2},{device_id:deviceId,field:'network',value:'wifi',observed_at:new Date(now-1000),received_at:new Date(now-2000),ttl_sec:3600}]};
    }
    if(sql.includes("field LIKE 'probe.%'")) { expect(sql).toContain('received_at'); return {rows:[{field:'probe.dial',value:{result:'ok',probedAt:now-1000,detail:null},observed_at:new Date(now-1000),received_at:new Date(now),ttl_sec:2},{field:'probe.answer',value:{result:'fail',probedAt:now-5000,detail:'old'},observed_at:new Date(now-5000),received_at:new Date(now),ttl_sec:2},{field:'probe.hangup',value:{result:'ok',probedAt:now+300001,detail:null},observed_at:new Date(now+300001),received_at:new Date(now),ttl_sec:2},{field:'probe.dtmf',value:{result:'ok',probedAt:now-1000,detail:null},observed_at:new Date(now-1000),received_at:new Date(now-1001),ttl_sec:3600},{field:'probe.uplink',value:{result:'ok',probedAt:now+300000,detail:null},observed_at:new Date(now+300000),received_at:new Date(now),ttl_sec:2},{field:'permissions',value:[{name:'phone',granted:true}],observed_at:new Date(now-1000),received_at:new Date(now),ttl_sec:2}]}; }
    if(sql.includes('FROM device_event')) {
      expect(sql).toContain('floor(extract(epoch from device_ts)*1000)');
      expect(sql).toContain('floor(extract(epoch from received_at)*1000)');
      expect(sql).toContain('LIMIT 50');
      expect(params).toEqual([deviceId]);
      return {rows:[{id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',deviceId,type:'status.snapshot',payload:{},deviceTs:null,receivedAt:'1699999999123'}]};
    }
    throw new Error('Unexpected query: '+sql);
  });
  const pool={query} as unknown as pg.Pool;
  const detail=await new DeviceDetailRepository(pool,new DeviceAdminRepository(pool)).get(deviceId);
  const parsed=adminDeviceDetail.parse(detail);
  expect(parsed.lastSeenAt).toBe(1699999999123);
  expect(parsed.sims[0]?.lastSeenAt).toBe(1699999999123);
  expect(parsed.recentEvents[0]).toMatchObject({deviceTs:null,receivedAt:1699999999123});
  expect(parsed.status.battery).toEqual({value:42,observedAt:now-1000,stale:false});
  expect(parsed.status.charging).toEqual({value:true,observedAt:now-5000,stale:true});
  expect(parsed.status.network).toEqual({value:'wifi',observedAt:now-1000,stale:true});
  expect(parsed.probes.dial.result).toBe('ok');
  expect(parsed.probes.answer).toEqual({result:'untested',probedAt:0,detail:null});
  expect(parsed.probes.hangup.result).toBe('untested');
  expect(parsed.probes.dtmf.result).toBe('untested');
  expect(parsed.probes.uplink.result).toBe('untested');
  expect(parsed.permissions).toEqual([{name:'phone',granted:true}]);
  expect(query).toHaveBeenCalledTimes(4);
});

it('stops after a missing or revoked device lookup',async()=>{
  const query=vi.fn(async(sql:string,params:unknown[])=>{
    expect(sql).toContain('d.revoked_at IS NULL');
    expect(sql).toContain('d.id=$6');
    expect(params[5]).toBe(deviceId);
    return {rows:[]};
  });
  const pool={query} as unknown as pg.Pool;
  expect(await new DeviceDetailRepository(pool,new DeviceAdminRepository(pool)).get(deviceId)).toBeNull();
  expect(query).toHaveBeenCalledTimes(1);
});
