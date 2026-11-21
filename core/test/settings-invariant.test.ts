import {expect, it, vi} from 'vitest';
import Fastify from 'fastify';
import {SettingsService} from '../src/settings/service.js';
import {registerSettingsPut} from '../src/settings/routes.js';
import type {Settings} from '../src/settings/schema.js';

it('validates merged settings in serialized order before persisting', async () => {
  let saved: Settings = {inboundPlatform:'qq',inboundRingTimeoutSec:20,outboundUserAnswerTimeoutSec:15,outboundCalleeAnswerTimeoutSec:30,outboundCallbackRingTimeoutSec:30,smsForward:true,smsRatePerMin:10,defaultDeviceId:null,botLocale:'en',heartbeatSec:30,offlineAfterSec:90,alertPushIntervalSec:1800,earlyMediaThresholdDbfs:-50};
  const update=vi.fn(async (patch:Partial<Settings>) => { const before={...saved}; const after={...saved,...patch}; if(after.offlineAfterSec<=after.heartbeatSec) throw Error('BAD_REQUEST'); saved=after; return {before,after}; });
  const service=new SettingsService({get:async()=>({...saved}),update},{publish:()=>{},updateDevices:()=>{}});
  const app=Fastify(); registerSettingsPut(app,service,async()=> 'admin');
  const put=(payload:object)=>app.inject({method:'PUT',url:'/api/settings',headers:{authorization:'Bearer valid'},payload});
  try {
    for(const payload of [{heartbeatSec:90},{offlineAfterSec:30},{heartbeatSec:100,offlineAfterSec:100}]) expect((await put(payload)).statusCode).toBe(400);
    expect(update).toHaveBeenCalledTimes(3);
    expect((await put({heartbeatSec:100,offlineAfterSec:101})).statusCode).toBe(200);
    expect((await put({offlineAfterSec:100})).statusCode).toBe(400);
    expect(saved.offlineAfterSec).toBe(101);
    expect((await put({heartbeatSec:86401,offlineAfterSec:86402})).statusCode).toBe(400);
    expect(saved.heartbeatSec).toBe(100);
    expect((await put({heartbeatSec:86400,offlineAfterSec:86401})).statusCode).toBe(200);
  } finally {await app.close();}
});
