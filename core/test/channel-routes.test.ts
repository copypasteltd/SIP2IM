import { expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerChannelRoutes } from '../src/channels/routes.js';
import { SettingsService } from '../src/settings/service.js';
import type { Settings } from '../src/settings/schema.js';
import { TransactionCommitUnknown, TransactionReleaseFailed } from '../src/db/pool.js';
import { SettingsConflict } from '../src/settings/repo.js';

it('authenticates, validates and persists inbound selection and paired-user revocation', async () => {
  let saved = {inboundPlatform:'qq',inboundRingTimeoutSec:20,outboundUserAnswerTimeoutSec:15,outboundCalleeAnswerTimeoutSec:30,outboundCallbackRingTimeoutSec:30,smsForward:true,smsRatePerMin:10,defaultDeviceId:null,botLocale:'en',heartbeatSec:30,offlineAfterSec:90,alertPushIntervalSec:1800,earlyMediaThresholdDbfs:-50} as Settings;
  const publish = vi.fn();
  const settings = new SettingsService({get:async()=>saved,update:async patch=>{const before={...saved};saved={...saved,...patch};return {before,after:{...saved}};}}, {publish,updateDevices:()=>{}});
  let paired: unknown | null = {id:'pair_1',platform:'telegram'};
  const revoke = vi.fn(async () => { paired = null; });
  const app = Fastify();
  registerChannelRoutes(app, settings, {pairedUser:async()=>paired,revokePairedUser:revoke}, async token=>token==='ok'?'admin':null);
  const headers = {authorization:'Bearer ok'};
  try {
    expect((await app.inject({method:'PUT',url:'/api/channels/inbound',payload:{platform:'telegram'}})).statusCode).toBe(401);
    for (const payload of [{platform:'other'},{platform:'qq',extra:true},{}]) expect((await app.inject({method:'PUT',url:'/api/channels/inbound',headers,payload})).statusCode).toBe(400);
    const changed = await app.inject({method:'PUT',url:'/api/channels/inbound',headers,payload:{platform:'telegram'}});
    expect(changed.json().data.inboundPlatform).toBe('telegram');
    expect((await settings.get()).inboundPlatform).toBe('telegram');
    expect((await app.inject({method:'GET',url:'/api/channels/telegram/paired-user',headers})).json().data).toEqual(paired);
    expect((await app.inject({method:'DELETE',url:'/api/channels/nope/paired-user',headers})).statusCode).toBe(400);
    expect((await app.inject({method:'DELETE',url:'/api/channels/telegram/paired-user',headers})).statusCode).toBe(200);
    expect(revoke).toHaveBeenCalledWith('telegram');
    expect((await app.inject({method:'GET',url:'/api/channels/telegram/paired-user',headers})).json().data).toBeNull();
    for (const [method,url] of [['POST','/api/channels/qq/pairing-code'],['PUT','/api/channels/qq/voice-verified']] as const) {
      expect((await app.inject({method,url,headers})).json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    }
  } finally { await app.close(); }
});
it.each([
  [new TransactionCommitUnknown('secret'), 'SETTINGS_WRITE_OUTCOME_UNKNOWN'],
  [new AggregateError([new AggregateError([new TransactionCommitUnknown('secret')])]), 'SETTINGS_WRITE_OUTCOME_UNKNOWN'],
  [new TransactionReleaseFailed('secret'), 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN'],
  [new AggregateError([new AggregateError([new TransactionReleaseFailed('secret')])]), 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN'],
  [new AggregateError([new TransactionReleaseFailed('secret'), new TransactionCommitUnknown('secret')]), 'SETTINGS_WRITE_OUTCOME_UNKNOWN'],
])('classifies inbound settings failures safely without retry', async (failure, code) => {
  const update = vi.fn(async () => { throw failure; });
  const app = Fastify();
  registerChannelRoutes(app, {update} as unknown as SettingsService, {pairedUser:async()=>null,revokePairedUser:async()=>{}}, async token => token === 'ok' ? 'admin' : null);
  try {
    const request = {method:'PUT',url:'/api/channels/inbound',payload:{platform:'qq'}} as const;
    expect((await app.inject(request)).statusCode).toBe(401);
    expect((await app.inject({...request, headers:{authorization:'Bearer ok'}, payload:{platform:'invalid'}})).statusCode).toBe(400);
    expect(update).not.toHaveBeenCalled();
    const response = await app.inject({...request, headers:{authorization:'Bearer ok'}});
    expect(response.statusCode).toBe(503);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.json()).toEqual({error:{code,message:code,details:null}});
    expect(update).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({inboundPlatform:'qq'});
  } finally { await app.close(); }
});

it('sanitizes unexpected inbound update errors without reporting a conflict', async () => {
  const update = vi.fn(async () => { throw new SettingsConflict(); });
  const app = Fastify();
  registerChannelRoutes(app, {update} as unknown as SettingsService, {pairedUser:async()=>null,revokePairedUser:async()=>{}}, async () => 'admin');
  try {
    const response = await app.inject({method:'PUT',url:'/api/channels/inbound',headers:{authorization:'Bearer ok'},payload:{platform:'qq'}});
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({error:{code:'INTERNAL_ERROR',message:'INTERNAL_ERROR',details:null}});
    expect(update).toHaveBeenCalledOnce();
  } finally { await app.close(); }
});
