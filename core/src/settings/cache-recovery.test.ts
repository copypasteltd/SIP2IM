import { expect, it, vi } from 'vitest';
import type pg from 'pg';
import { SettingsRepository, SettingsConflict, SETTINGS_LOCK_KEY } from './repo.js';
import { SettingsService } from './service.js';
import { TransactionCommitUnknown, TransactionRolledBack } from '../db/pool.js';
import type { Settings } from './schema.js';

const defaults: Settings = { inboundPlatform:'qq', inboundRingTimeoutSec:20, outboundUserAnswerTimeoutSec:15, outboundCalleeAnswerTimeoutSec:30, outboundCallbackRingTimeoutSec:30, smsForward:true, smsRatePerMin:10, defaultDeviceId:null, botLocale:'en', heartbeatSec:30, offlineAfterSec:90, alertPushIntervalSec:1800, earlyMediaThresholdDbfs:-50 };
const snake = (s: string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
function fake() {
  let values: Record<string, unknown> = Object.fromEntries(Object.entries(defaults).map(([k,v]) => [snake(k),v]));
  let tail = Promise.resolve();
  let commitMode: 'ok' | 'unknown' | 'unknown-no-apply' | 'rollback' | 'readback' = 'ok';
  const events: string[] = [];
  const rows = (data: Record<string, unknown>) => Object.entries(data).map(([key,value]) => ({key,value}));
  const pool = {
    query: async () => ({rows:rows(values)}),
    connect: async () => {
      let draft: Record<string,unknown> = {};
      let unlock: (()=>void) | undefined;
      let wrote = false;
      return {
        query: async (sql:string, args?:unknown[]) => {
          events.push(sql);
          if (sql === 'BEGIN') return {rows:[],command:'BEGIN'};
          if (sql.includes('pg_advisory_xact_lock')) {
            expect(args).toEqual([...SETTINGS_LOCK_KEY]);
            const previous=tail; tail=new Promise<void>(resolve=>{unlock=resolve;});
            await previous; draft={...values}; return {rows:[]};
          }
          if (sql === 'SELECT key,value FROM setting') { if(wrote && commitMode==='readback') {commitMode='ok'; throw Error('readback failed');} return {rows:rows(draft)}; }
          if (sql.startsWith('INSERT')) {wrote=true; Object.assign(draft,JSON.parse(args![0] as string)); return {rows:[]};}
          if (sql === 'COMMIT') {
            const mode=commitMode; commitMode='ok';
            if(mode!=='rollback' && mode!=='unknown-no-apply') values={...draft};
            unlock?.(); unlock=undefined;
            if(mode==='unknown' || mode==='unknown-no-apply') throw Error('lost commit reply');
            return {rows:[],command:mode==='rollback'?'ROLLBACK':'COMMIT'};
          }
          if (sql === 'ROLLBACK') {unlock?.(); unlock=undefined; return {rows:[],command:'ROLLBACK'};}
          throw Error(sql);
        },
        release: () => {},
      };
    },
  } as unknown as pg.Pool;
  return {pool,events, failCommit: (mode:'unknown'|'unknown-no-apply'|'rollback'|'readback')=>{commitMode=mode;}};
}

it('checks expectations under the shared lock and never writes or emits on conflict', async () => {
  const f=fake(); const effects={publish:vi.fn(),updateDevices:vi.fn()};
  const one=new SettingsService(new SettingsRepository(f.pool),effects);
  const two=new SettingsService(new SettingsRepository(f.pool),effects);
  const results=await Promise.allSettled([one.update({heartbeatSec:40},{heartbeatSec:30}),two.update({heartbeatSec:50},{heartbeatSec:30})]);
  expect(results[0]?.status).toBe('fulfilled');
  expect(results[1]?.status).toBe('rejected');
  if (results[1]?.status==='rejected') expect(results[1].reason).toBeInstanceOf(SettingsConflict);
  expect(f.events.filter(s=>s.startsWith('INSERT'))).toHaveLength(1);
  expect(f.events.filter(s=>s==='ROLLBACK')).toHaveLength(1);
  expect((await two.get()).heartbeatSec).toBe(40);
  await vi.waitFor(()=>expect(effects.publish).toHaveBeenCalledTimes(1));
  expect(effects.updateDevices).toHaveBeenCalledTimes(1);
});

it('rejects the entire multi-field update when one expectation is stale', async () => {
  const f=fake(); const effects={publish:vi.fn(),updateDevices:vi.fn()};
  const service=new SettingsService(new SettingsRepository(f.pool),effects);
  await expect(service.update({heartbeatSec:40,smsForward:false},{heartbeatSec:30,smsForward:false})).rejects.toBeInstanceOf(SettingsConflict);
  expect(f.events.filter(s=>s.startsWith('INSERT'))).toHaveLength(0);
  expect(f.events).toContain('ROLLBACK');
  expect(await service.get()).toEqual(defaults);
  expect(effects.publish).not.toHaveBeenCalled(); expect(effects.updateDevices).not.toHaveBeenCalled();
});

it('matches null explicitly and allows independent field updates', async () => {
  const f=fake(); const repo=new SettingsRepository(f.pool);
  await repo.update({smsRatePerMin:null},{smsRatePerMin:10});
  await repo.update({smsForward:false},{smsForward:true});
  expect((await repo.update({smsRatePerMin:5},{smsRatePerMin:null})).after.smsRatePerMin).toBe(5);
  await expect(repo.update({smsRatePerMin:6},{smsRatePerMin:null})).rejects.toBeInstanceOf(SettingsConflict);
  expect((await repo.get()).smsForward).toBe(false);
});

it('serializes two instances and validates against committed state under the lock', async () => {
  const f=fake(); const one=new SettingsService(new SettingsRepository(f.pool),{publish:()=>{},updateDevices:()=>{}});
  const two=new SettingsService(new SettingsRepository(f.pool),{publish:()=>{},updateDevices:()=>{}});
  await one.get(); await two.get();
  const results=await Promise.allSettled([one.update({heartbeatSec:80}),two.update({offlineAfterSec:70})]);
  expect(results[0]?.status).toBe('fulfilled'); expect(results[1]?.status).toBe('rejected');
  expect((await two.get()).heartbeatSec).toBe(80); expect((await one.get()).offlineAfterSec).toBe(90);
  expect(f.events.filter(s=>s.startsWith('INSERT'))).toHaveLength(1);
  expect(f.events.filter(s=>s==='ROLLBACK')).toHaveLength(1);
});

it('accepts a patch valid after another instance changes the state', async () => {
  const f=fake(); const effects={publish:vi.fn(),updateDevices:vi.fn()};
  const one=new SettingsService(new SettingsRepository(f.pool),effects); const two=new SettingsService(new SettingsRepository(f.pool),effects);
  await one.get(); await two.update({offlineAfterSec:120});
  expect((await one.update({heartbeatSec:100})).offlineAfterSec).toBe(120);
});

it.each(['rollback','unknown','unknown-no-apply'] as const)('does not publish a %s commit and keeps fresh reads', async mode => {
  const f=fake(); const publish=vi.fn(); const devices=vi.fn();
  const service=new SettingsService(new SettingsRepository(f.pool),{publish,updateDevices:devices});
  await service.get(); f.failCommit(mode);
  await expect(service.update({heartbeatSec:80})).rejects.toBeInstanceOf(mode==='rollback'?TransactionRolledBack:TransactionCommitUnknown);
  expect(publish).not.toHaveBeenCalled(); expect(devices).not.toHaveBeenCalled();
  expect((await service.get()).heartbeatSec).toBe(mode==='unknown'?80:30);
});

it('keeps reading after a potentially late failed write and a later success', async () => {
  let saved={...defaults}; let first=true;
  const service=new SettingsService({get:async()=>({...saved}),update:async patch=>{
    if(first){first=false;throw Error('unknown');} const before={...saved}; saved={...saved,...patch}; return {before,after:{...saved}};
  }},{publish:()=>{},updateDevices:()=>{}});
  await expect(service.update({heartbeatSec:80})).rejects.toThrow('unknown');
  await service.update({smsForward:false}); saved={...saved,heartbeatSec:80};
  expect((await service.get()).heartbeatSec).toBe(80);
});
it('keeps effects ordered across a failed and a later successful write', async () => {
  let saved={...defaults}; const events:string[]=[]; let release!:()=>void; let started!:()=>void;
  const wait=new Promise<void>(r=>{release=r;}); const entered=new Promise<void>(r=>{started=r;});
  const service=new SettingsService({get:async()=>({...saved}),update:async patch=>{
    const before={...saved}; saved={...saved,...patch}; if(patch.heartbeatSec===50) throw Error('unknown');
    return {before,after:{...saved}};
  }},{publish:async s=>{events.push('publish:'+s.heartbeatSec);if(s.heartbeatSec===40){started();await wait;}},updateDevices:c=>{events.push('devices:'+c.heartbeatSec);}});
  await service.update({heartbeatSec:40}); await entered;
  await expect(service.update({heartbeatSec:50})).rejects.toThrow('unknown');
  await service.update({heartbeatSec:60}); expect(events).toEqual(['publish:40']);
  release(); await vi.waitFor(()=>expect(events).toEqual(['publish:40','devices:40','publish:60','devices:60']));
});
it('rolls back a readback failure before COMMIT without effects', async () => {
  const f=fake(); const publish=vi.fn(); const devices=vi.fn();
  const service=new SettingsService(new SettingsRepository(f.pool),{publish,updateDevices:devices});
  f.failCommit('readback'); await expect(service.update({heartbeatSec:80})).rejects.toThrow('readback failed');
  expect(f.events).toContain('ROLLBACK'); expect(f.events).not.toContain('COMMIT');
  expect((await service.get()).heartbeatSec).toBe(30);
  expect(publish).not.toHaveBeenCalled(); expect(devices).not.toHaveBeenCalled();
});
