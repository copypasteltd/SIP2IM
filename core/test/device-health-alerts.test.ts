import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { adminAlert } from '@voipgw/protocol';
import { readFile } from 'node:fs/promises';
import { assessDeviceHealth, DeviceHealthAlerts, qualifyFindings, type DeviceHealthAlert,
  type HealthDevice, type HealthSim, type HealthStatus } from '../src/devices/health-alerts.js';

const base = 1_750_000_000_000;
const now = new Date(base);
const phoneId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const simId = 'sim_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const phone = (overrides: Partial<HealthDevice> = {}): HealthDevice => ({
  id: phoneId, enabled: true, revoked: false, online: true, call_enabled: true,
  last_seen_at: now, ...overrides,
});
const observation = (field: string, value: unknown, overrides: Partial<HealthStatus> = {}): HealthStatus => ({
  field, device_id: phoneId, value, observed_at: now, received_at: now, ttl_sec: 90, ...overrides,
});
const sim = (overrides: Partial<HealthSim> = {}): HealthSim => ({
  id: simId, device_id: phoneId, state: 'locked', retired: false, last_seen_at: now, ...overrides,
});
const permissions = (send: boolean, receive: boolean) => observation('permissions',
  [{name:'android.permission.SEND_SMS',granted:send},{name:'RECEIVE_SMS',granted:receive}], {ttl_sec: 86_400});
const beliefs = (device: HealthDevice, status: HealthStatus[] = [], sims: HealthSim[] = [], at = base) =>
  Object.fromEntries(assessDeviceHealth(device, status, sims, at, 90).map(row => [row.type, row.belief]));

describe('evidence for device health alerts', () => {
  it('only flags a persisted timeout of a previously observed, enabled device', () => {
    expect(beliefs(phone({online:false,last_seen_at:null})).device_offline).toBe('unknown');
    expect(beliefs(phone({online:false,last_seen_at:new Date(base-90_000)})).device_offline).toBe('unknown');
    expect(beliefs(phone({online:false,last_seen_at:new Date(base-90_001)})).device_offline).toBe('bad');
    expect(beliefs(phone({last_seen_at:new Date(base-90_001)})).device_offline).toBe('unknown');
    expect(beliefs(phone({last_seen_at:new Date(base+1)})).device_offline).toBe('unknown');
    expect(beliefs(phone()).device_offline).toBe('clear');
  });

  it('does not mistake missing, stale or contradictory observations for outage or recovery', () => {
    expect(beliefs(phone(),[],[sim({state:'unknown'})])).toEqual({device_offline:'clear',
      shizuku_stopped:'unknown',sms_permission_missing:'unknown',sim_not_ready:'unknown'});
    expect(beliefs(phone(),[observation('shizuku','stopped',{observed_at:new Date(base+1)})]).shizuku_stopped).toBe('unknown');
    expect(beliefs(phone(),[observation('shizuku','stopped',{observed_at:new Date(base-90_001)})]).shizuku_stopped).toBe('unknown');
    expect(beliefs(phone(),[observation('shizuku','stopped',{received_at:new Date(base-1)})]).shizuku_stopped).toBe('unknown');
    expect(beliefs(phone(),[observation('shizuku','stopped')]).shizuku_stopped).toBe('bad');
    expect(beliefs(phone(),[observation('shizuku','running')]).shizuku_stopped).toBe('clear');
    expect(beliefs(phone(),[permissions(false,true)]).sms_permission_missing).toBe('bad');
    expect(beliefs(phone(),[permissions(true,true)]).sms_permission_missing).toBe('clear');
    expect(beliefs(phone(),[observation('permissions',[{name:'SEND_SMS',granted:true}])]).sms_permission_missing).toBe('unknown');
    expect(beliefs(phone(),[observation('permissions',[{name:'SEND_SMS',granted:true},{name:'SEND_SMS'},{name:'RECEIVE_SMS',granted:true}])]).sms_permission_missing).toBe('unknown');
    expect(beliefs(phone(),[observation('permissions',[{name:'SEND_SMS',granted:true},{name:'android.permission.SEND_SMS',granted:false}])]).sms_permission_missing).toBe('unknown');
    expect(beliefs(phone(),[],[sim({last_seen_at:new Date(base-7_200_001)})]).sim_not_ready).toBe('unknown');
    expect(beliefs(phone(),[],[sim()]).sim_not_ready).toBe('bad');
    expect(beliefs(phone(),[],[sim({state:'ready'})]).sim_not_ready).toBe('clear');
  });

  it('uses an independently denied permission even when the other is ambiguous', () => {
    const valueWithDeniedReceive = [{name:'SEND_SMS',granted:true},{name:'android.permission.SEND_SMS',granted:false},
      {name:'RECEIVE_SMS',granted:false}];
    const valueWithDeniedSend = [{name:'android.permission.SEND_SMS',granted:false},{name:'SEND_SMS',granted:false},
      {name:'RECEIVE_SMS',granted:true},{name:'android.permission.RECEIVE_SMS'}];
    for (const value of [valueWithDeniedReceive, valueWithDeniedSend]) {
      expect(beliefs(phone(),[observation('permissions',value)]).sms_permission_missing).toBe('bad');
    }
    expect(beliefs(phone(),[observation('permissions',[{name:'SEND_SMS',granted:false}])]).sms_permission_missing).toBe('bad');
    expect(beliefs(phone(),[observation('permissions',
      [{name:'SEND_SMS',granted:false},{name:'android.permission.SEND_SMS',granted:'false'}])]).sms_permission_missing).toBe('unknown');
  });

  it('keeps permission alert evidence unknown outside valid timestamp and TTL boundaries', () => {
    const denied = permissions(false,true);
    const assess = (overrides: Partial<HealthStatus>, at = base) =>
      beliefs(phone({last_seen_at:new Date(at)}),[{...denied,...overrides}],[],at).sms_permission_missing;
    expect(assess({received_at:new Date(base+1)})).toBe('unknown');
    expect(assess({observed_at:new Date(NaN)})).toBe('unknown');
    expect(assess({received_at:new Date(NaN)})).toBe('unknown');
    for (const ttl_sec of [0,-1,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) {
      expect(assess({ttl_sec})).toBe('unknown');
    }
    expect(assess({ttl_sec:1},base+1_000)).toBe('bad');
    expect(assess({ttl_sec:1},base+1_001)).toBe('unknown');
    expect(assess({ttl_sec:172_800},base+86_400_000)).toBe('bad');
    expect(assess({ttl_sec:172_800},base+86_400_001)).toBe('unknown');
  });

  it('clears alert monitoring on explicit decommissioning but not on unknown data', () => {
    const status = [observation('shizuku','stopped'), permissions(false,true)];
    expect(beliefs(phone({enabled:false}),status,[sim()])).toEqual({device_offline:'clear',
      shizuku_stopped:'clear',sms_permission_missing:'clear',sim_not_ready:'clear'});
    expect(beliefs(phone({call_enabled:false}),status,[sim({retired:true})])).toMatchObject({
      shizuku_stopped:'clear',sms_permission_missing:'bad',sim_not_ready:'clear',
    });
    expect(beliefs(phone({online:false,last_seen_at:new Date(base-180_000)}),status,[sim()])).toEqual({
      device_offline:'bad',shizuku_stopped:'unknown',sms_permission_missing:'unknown',sim_not_ready:'unknown',
    });
  });

  it('requires 60 seconds of bounded samples and restarts debounce after uncertainty or a sampling gap', () => {
    const make = (state: string, at: number) => assessDeviceHealth(phone({last_seen_at:new Date(at)}),
      [observation('shizuku',state,{observed_at:new Date(at),received_at:new Date(at)})],[],at,90);
    let previous = qualifyFindings(make('stopped',base),new Map(),base);
    const delayed = () => previous.ready.some(row => row.type==='shizuku_stopped' && row.belief==='bad');
    for(const elapsed of [0,20_000,40_000,59_999,60_000]) {
      previous=qualifyFindings(make('stopped',base+elapsed),previous.windows,base+elapsed);
      expect(delayed()).toBe(elapsed===60_000);
    }
    previous=qualifyFindings(make('unknown',base+70_000),previous.windows,base+70_000);
    expect(previous.windows.size).toBe(0);
    previous=qualifyFindings(make('stopped',base+80_000),previous.windows,base+80_000);
    previous=qualifyFindings(make('stopped',base+125_000),previous.windows,base+125_000);
    expect(delayed()).toBe(false);
    expect(previous.windows.get('shizuku_stopped:'+phoneId)?.since).toBe(base+125_000);
  });
});

type CurrentAlert = { id: string; type: DeviceHealthAlert; subject_type: string; subject_id: string;
  state: 'open' | 'acked' | 'resolved'; firstAt: number; lastAt: number; resolvedAt: number | null };
type Payload = { id?: string; type: DeviceHealthAlert; subject_type: string; subject_id: string; evidence_at: string | null };
const fixture = () => {
  let at = base;
  let clockAvailable = true;
  let committed = false;
  let failCommit = false;
  const alertRows: CurrentAlert[] = [];
  let roles = permissions(false,true);
  let dev = phone();
  const result = (rows: unknown[] = [], command = 'SELECT') => ({ rows, command, rowCount: rows.length });
  const dto = (row: CurrentAlert) => ({ id: row.id, type: row.type, subjectType: row.subject_type, subjectId: row.subject_id,
    state: row.state, severity:'warning', detail:{}, firstAt:row.firstAt,lastAt:row.lastAt,pushedAt:null,resolvedAt:row.resolvedAt });
  let saved: CurrentAlert[] = [];
  const query = vi.fn(async (sql: string, args: unknown[] = []) => {
    if (sql==='BEGIN') { committed=false; saved=alertRows.map(row=>({...row})); return result([],'BEGIN'); }
    if (sql==='COMMIT') { if(failCommit)throw new Error('commit response lost'); committed=true;return result([],'COMMIT'); }
    if (sql==='ROLLBACK') { alertRows.splice(0,alertRows.length,...saved);return result([],'ROLLBACK'); }
    if (sql==='SET TRANSACTION ISOLATION LEVEL READ COMMITTED') return result();
    if (sql.startsWith('SELECT d.id')) {
      expect(sql).toContain('ORDER BY d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED');
      expect(args).toEqual([null,24]);
      return result([dev]);
    }
    if (sql.includes('FROM device_status')) { expect(args).toEqual([[phoneId]]);return result([roles]); }
    if (sql.startsWith('SELECT s.id')) return result();
    if (sql==='SELECT clock_timestamp() AS at') return clockAvailable ? result([{at:new Date(at)}]) : result();
    const isSame = (a: CurrentAlert,b: Payload) => a.type===b.type && a.subject_type===b.subject_type && a.subject_id===b.subject_id;
    const events: unknown[]=[];
    if (sql.startsWith('UPDATE alert AS a SET state=') || sql.startsWith('INSERT INTO alert AS a') || sql.startsWith('UPDATE alert AS a SET last_at')) {
      expect(typeof args[0]).toBe('string');
      for(const wanted of JSON.parse(String(args[0])) as Payload[]) {
        const episode = alertRows.find(row=>isSame(row,wanted) && row.resolvedAt===null && row.state!=='resolved');
        if (sql.startsWith('UPDATE alert AS a SET state=')) {
          if (episode) { if(episode.state==='open')episode.state='resolved';episode.resolvedAt=at;events.push(dto(episode)); }
        } else if (sql.startsWith('UPDATE alert AS a SET last_at')) {
          if (episode?.state==='open' && wanted.evidence_at) episode.lastAt=Math.max(episode.lastAt, Date.parse(wanted.evidence_at));
        } else {
          expect(sql).toContain("ON CONFLICT (type,subject_id) WHERE state='open' DO NOTHING");
          expect(sql).toContain("a.state IN ('open','acked') AND a.resolved_at IS NULL");
          expect(sql).toContain('a.resolved_at>=t.evidence_at');
          if(episode||!wanted.evidence_at||alertRows.some(row=>isSame(row,wanted)&&row.resolvedAt!==null&&row.resolvedAt>=Date.parse(wanted.evidence_at!)))continue;
          const row: CurrentAlert={id:wanted.id!,type:wanted.type,subject_type:wanted.subject_type,subject_id:wanted.subject_id,
            state:'open',firstAt:at,lastAt:at,resolvedAt:null};
          alertRows.push(row);events.push(dto(row));
        }
      }
      return result(events);
    }
    throw new Error('unexpected query: '+sql);
  });
  const publish = vi.fn(async (_type: 'alert.raised'|'alert.resolved', data: unknown) => {
    expect(committed).toBe(true); expect(adminAlert.safeParse(data).success).toBe(true);
  });
  const recon = new DeviceHealthAlerts({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
  return { recon, query, publish, alertRows, setClock(next: number) { at=next; dev=phone({last_seen_at:new Date(next)}); },
    setRole(value: HealthStatus) { roles=value; }, setDevice(value: HealthDevice) { dev=value; }, failCommit() { failCommit=true; }, loseClock() { clockAvailable=false; } };
};

it('commits alert evidence before emitting transitions and retains acknowledgement history', async () => {
  const f=fixture();
  await f.recon.sweep(90,()=>{},f.publish);
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.publish.mock.calls.map(([type])=>type)).toEqual(['alert.raised']);
  const first=f.alertRows[0]!;
  first.state='acked';
  f.setClock(base+10_000);
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows).toHaveLength(1);
  f.setClock(base+20_000);
  f.setRole({...permissions(false,true),observed_at:new Date(base+20_000),received_at:new Date(base+20_000)});
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows.map(row=>row.state)).toEqual(['acked']);
  f.setClock(base+30_000);
  f.setRole({...permissions(true,true),observed_at:new Date(base+30_000),received_at:new Date(base+30_000)});
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows[0]?.state).toBe('acked');
  expect(f.alertRows[0]?.resolvedAt).toBe(base+30_000);
  f.setClock(base+40_000);
  f.setRole(permissions(false,true)); // Historical evidence cannot reopen a recovered episode.
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows).toHaveLength(1);
  f.setRole({...permissions(false,true),observed_at:new Date(base+40_000),received_at:new Date(base+40_000)});
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows.map(row=>row.state)).toEqual(['acked','open']);
  f.setClock(base+50_000);
  f.setRole({...permissions(true,true),observed_at:new Date(base+50_000),received_at:new Date(base+50_000)});
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows.map(row=>row.state)).toEqual(['acked','resolved']);
  expect(f.publish.mock.calls.map(([type])=>type)).toEqual(['alert.raised','alert.resolved','alert.raised','alert.resolved']);
});

it('alerts on a second offline timeout when the recovery sweep ran after the last heartbeat', async () => {
  const f=fixture();
  f.setRole(observation('permissions',[]));
  f.setDevice(phone({online:false,last_seen_at:new Date(base-100_000)}));
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows.map(row=>[row.type,row.state])).toEqual([['device_offline','open']]);
  const heartbeat = new Date(base+5_000);
  f.setClock(base+10_000);
  f.setDevice(phone({last_seen_at:heartbeat}));
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows[0]?.resolvedAt).toBe(base+10_000);
  f.setClock(base+100_000);
  f.setDevice(phone({online:false,last_seen_at:heartbeat}));
  await f.recon.sweep(90,()=>{},f.publish);
  expect(f.alertRows.map(row=>row.state)).toEqual(['resolved','open']);
  expect(f.publish.mock.calls.map(([type])=>type)).toEqual(['alert.raised','alert.resolved','alert.raised']);
});

it('does not emit after unconfirmed commit, missing DB clock or stopped admission', async () => {
  const lost=fixture();lost.failCommit();
  await expect(lost.recon.sweep(90,()=>{},lost.publish)).rejects.toThrow('outcome is uncertain');
  expect(lost.publish).not.toHaveBeenCalled();
  const clock=fixture();clock.loseClock();
  await expect(clock.recon.sweep(90,()=>{},clock.publish)).rejects.toThrow('clock unavailable');
  expect(clock.publish).not.toHaveBeenCalled();
  const stopped=fixture();
  await expect(stopped.recon.sweep(90,()=>{throw new Error('Core is stopping');},stopped.publish)).rejects.toThrow('Core is stopping');
  expect(stopped.query).not.toHaveBeenCalled();
});

it('runs health reconciliation only from the drained production timer after updating presence',async()=>{
  const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  const timer=source.slice(source.indexOf('const presence=new TrackedInterval'),source.indexOf('transportLifecycle.defer(()=>presence.stop()'));
  expect(timer.indexOf('status.markOffline(offlineAfterSec)')).toBeGreaterThan(-1);
  expect(timer.indexOf('healthAlerts.sweep(offlineAfterSec, assertAdmission')).toBeGreaterThan(timer.indexOf('status.markOffline(offlineAfterSec)'));
  expect(timer).toContain('hub.publish(type, data)');
});
