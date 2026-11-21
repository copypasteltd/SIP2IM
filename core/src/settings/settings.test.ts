import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import type pg from 'pg';
import { SettingsRepository } from './repo.js';
import { SettingsService } from './service.js';
import { registerSettingsPut } from './routes.js';
import type { Settings } from './schema.js';
import { SettingsConflict } from './repo.js';
import { TransactionCommitUnknown } from '../db/pool.js';

const defaults: Settings = { inboundPlatform:'qq', inboundRingTimeoutSec:20, outboundUserAnswerTimeoutSec:15, outboundCalleeAnswerTimeoutSec:30, outboundCallbackRingTimeoutSec:30, smsForward:true, smsRatePerMin:10, defaultDeviceId:null, botLocale:'zh-CN', heartbeatSec:30, offlineAfterSec:90, alertPushIntervalSec:1800, earlyMediaThresholdDbfs:-50 };
const snake = (s:string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());

describe('settings', () => {
  it('persists null and scalar values through parameterized JSONB and reads camelCase', async () => {
    const values: Record<string,unknown> = Object.fromEntries(Object.entries(defaults).map(([k,v]) => [snake(k),v]));
    const query = vi.fn(async (sql:string, args?:unknown[]) => {
      if (sql === 'COMMIT' || sql === 'ROLLBACK') return {rows:[],command:sql};
      if (sql.startsWith('INSERT')) Object.assign(values, JSON.parse(args![0] as string));
      return {rows:Object.entries(values).map(([key,value]) => ({key,value}))};
    });
    const repo = new SettingsRepository({query,connect:async()=>({query,release(){}})} as unknown as pg.Pool);
    expect((await repo.update({smsRatePerMin:null, heartbeatSec:42})).after).toEqual({...defaults,smsRatePerMin:null,heartbeatSec:42});
    expect(query.mock.calls.find(([sql])=>sql.startsWith('INSERT'))?.[1]).toEqual(['{"sms_rate_per_min":null,"heartbeat_sec":42}']);
  });
  it('orders writes and effects and pushes only changed device config', async () => {
    let saved = {...defaults};
    const events:string[] = [];
    const service = new SettingsService({get:async()=>({...saved}),update:async patch=>{const before={...saved};saved={...saved,...patch}; events.push('save'); return {before,after:{...saved}};}}, {publish:async()=>{events.push('publish');},updateDevices:async()=>{events.push('devices');}});
    const [one,two] = await Promise.all([service.update({heartbeatSec:40}),service.update({smsForward:false})]);
    expect(one.heartbeatSec).toBe(40); expect(two.smsForward).toBe(false);
    expect(events.filter(e=>e==='save')).toEqual(['save','save']);
    expect(await service.get()).toEqual(saved);
  });
  it('validates the conditional request and returns sanitized conflicts', async () => {
    const update=vi.fn(async () => { throw new SettingsConflict(); });
    const publish=vi.fn(); const devices=vi.fn();
    const app=Fastify(); registerSettingsPut(app,new SettingsService({get:async()=>defaults,update},{publish,updateDevices:devices}),async token=>token==='valid'?'admin':null);
    const headers={authorization:'Bearer valid'};
    const url='/api/settings/conditional';
    for (const payload of [{changes:{},expected:{}},{changes:{smsForward:false},expected:{}},{changes:{smsForward:false},expected:{smsForward:true,heartbeatSec:30}},{changes:{smsForward:null},expected:{smsForward:true}},{changes:{smsForward:false},expected:{smsForward:true},extra:true}]) {
      expect((await app.inject({method:'PUT',url,headers,payload})).statusCode).toBe(400);
    }
    for (const payload of ['{"changes":{"__proto__":{"smsForward":false}},"expected":{"__proto__":{"smsForward":true}}}', '{"changes":{"constructor":false},"expected":{"constructor":true}}', '{"changes":{"smsForward":false,"__proto__":{}},"expected":{"smsForward":true}}']) {
      const bad=await app.inject({method:'PUT',url,headers:{...headers,'content-type':'application/json'},payload});
      expect(bad.statusCode).toBe(400);
    }
    expect(update).not.toHaveBeenCalled();
    const response=await app.inject({method:'PUT',url,headers,payload:{changes:{smsRatePerMin:5},expected:{smsRatePerMin:null}}});
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({error:{code:'SETTINGS_CONFLICT',message:'SETTINGS_CONFLICT',details:null}});
    expect(update).toHaveBeenCalledWith({smsRatePerMin:5},{smsRatePerMin:null});
    expect(publish).not.toHaveBeenCalled(); expect(devices).not.toHaveBeenCalled();
    await app.close();
  });
  it('rejects explicit undefined on internal conditional calls', async () => {
    const update=vi.fn();
    const service=new SettingsService({get:async()=>defaults,update},{publish:()=>{},updateDevices:()=>{}});
    expect(()=>service.update({smsRatePerMin:undefined},{smsRatePerMin:null})).toThrow();
    expect(()=>service.update({smsRatePerMin:null},{smsRatePerMin:undefined})).toThrow();
    expect(update).not.toHaveBeenCalled();
  });
  it('preserves uncertain commit and cleanup failure classification on conditional updates', async () => {
    let failure: Error = new TransactionCommitUnknown(new Error('private database details'));
    const effects={publish:vi.fn(),updateDevices:vi.fn()};
    const app=Fastify(); registerSettingsPut(app,new SettingsService({get:async()=>defaults,update:async()=>{throw failure;}},effects),async()=> 'admin');
    const request={method:'PUT' as const,url:'/api/settings/conditional',headers:{authorization:'Bearer valid'},payload:{changes:{heartbeatSec:40},expected:{heartbeatSec:30}}};
    const unknown=await app.inject(request);
    expect(unknown.statusCode).toBe(503);
    expect(unknown.json().error).toEqual({code:'SETTINGS_WRITE_OUTCOME_UNKNOWN',message:'SETTINGS_WRITE_OUTCOME_UNKNOWN',details:null});
    failure=new AggregateError([new SettingsConflict(),new Error('rollback failed')]);
    const cleanup=await app.inject(request);
    expect(cleanup.statusCode).toBe(500); expect(cleanup.json().error.code).toBe('INTERNAL_ERROR');
    expect(effects.publish).not.toHaveBeenCalled(); expect(effects.updateDevices).not.toHaveBeenCalled();
    await app.close();
  });
  it('authenticates and validates PUT before mutating', async () => {
    let saved = {...defaults};
    const update = vi.fn(async (patch:Partial<Settings>)=>{const before={...saved};saved={...saved,...patch};return {before,after:{...saved}};});
    const service = new SettingsService({get:async()=>({...saved}),update}, {publish:()=>{},updateDevices:()=>{}});
    const app = Fastify(); registerSettingsPut(app,service,async token=>token==='valid'?'admin':null);
    expect((await app.inject({method:'PUT',url:'/api/settings',payload:{heartbeatSec:20}})).statusCode).toBe(401);
    for (const payload of [{heartbeatSec:0},{unknown:true},{}]) expect((await app.inject({method:'PUT',url:'/api/settings',headers:{authorization:'Bearer valid'},payload})).statusCode).toBe(400);
    const response=await app.inject({method:'PUT',url:'/api/settings',headers:{authorization:'Bearer valid'},payload:{botLocale:'en'}});
    expect(response.statusCode).toBe(200); expect(response.json().data.botLocale).toBe('en'); expect(update).toHaveBeenCalledTimes(1);
    await app.close();
  });
});
