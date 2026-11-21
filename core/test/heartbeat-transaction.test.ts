import {describe,it,expect} from 'vitest';
import type pg from 'pg';
import {DeviceStatusRepository} from '../src/devices/repo.js';
import {DeviceAdminRepository} from '../src/devices/admin-repo.js';

// This fake serializes the device row like PostgreSQL; it does not exercise a real database.
function fakeDb() {
  let device={enabled:true,revoked_at:null as Date|null,online:false};
  let statuses:Record<string,unknown>={};
  let tail=Promise.resolve();
  let locked!:()=>void;
  const lockObserved=new Promise<void>(r=>{locked=r;});
  let resume!:()=>void;
  let pause:Promise<void>|undefined;
  const acquire=async()=>{let release!:()=>void;const next=new Promise<void>(r=>{release=r;});const previous=tail;tail=next;await previous;return release;};
  let failStatus=false;
  const connect=async()=>{let release:(()=>void)|undefined;let draft=structuredClone(device);let nextStatuses={...statuses};
    return {release(){release?.();},async query(sql:string,params:unknown[]=[]){
      if(sql==='BEGIN'||sql.startsWith('SET TRANSACTION')||sql.startsWith('SET LOCAL'))return {rows:[],rowCount:0};
      if(sql.startsWith('SELECT code_hash FROM binding_code WHERE used_by_device='))return {rows:[],rowCount:0};
      if(sql.startsWith('SELECT token_hash FROM device_credential')){if(!release)throw new Error('Credential locked before device');return {rows:[],rowCount:0};}
      if(sql.includes('FOR UPDATE')){release=await acquire();draft=structuredClone(device);nextStatuses={...statuses};locked();if(pause)await pause;return {rows:[{...draft,heartbeat_future:false,heartbeat_recent:true}],rowCount:1};}
      if(sql.includes('clock_timestamp()'))return {rows:[{received_at:new Date(123)}],rowCount:1};
      if(sql.startsWith('INSERT INTO device_status')){if(failStatus)throw new Error('injected failure');nextStatuses[String(params[1])]=params[2];return {rows:[{field:params[1]}],rowCount:1};}
      if(sql.startsWith('UPDATE device SET online=true')){draft.online=true;return {rows:[],rowCount:1};}
      if(sql.startsWith('UPDATE device SET revoked_at=')){if(!release)throw new Error('Device updated before lock');draft.revoked_at=new Date();draft.online=false;return {rows:[],rowCount:1};}
      if(sql.startsWith('UPDATE device_credential'))return {rows:[],rowCount:1};
      if(sql==='COMMIT'){if(release){device=draft;statuses=nextStatuses;release();release=undefined;}return {rows:[],rowCount:0,command:'COMMIT'};}
      if(sql==='ROLLBACK'){release?.();release=undefined;return {rows:[],rowCount:0,command:'ROLLBACK'};}
      throw new Error('Unexpected SQL '+sql);
    }};};
  const query=async(sql:string,params:unknown[])=>{if(!sql.startsWith('UPDATE device SET name='))throw new Error('Unexpected SQL '+sql);if(!sql.includes('online=CASE WHEN $3::boolean=false THEN false ELSE online END'))throw new Error('disable must clear online atomically');const release=await acquire();try{if(params[2]===false){device.enabled=false;device.online=false;}return {rowCount:1,rows:[]};}finally{release();}};
  return {pool:{connect,query} as unknown as pg.Pool, read:()=>({device:{...device},statuses:{...statuses}}), pauseLock:()=>{pause=new Promise<void>(r=>{resume=r;});},lockObserved,resume:()=>resume(),fail:()=>{failStatus=true;}};
}

describe('guarded heartbeat',()=>{
  for(const action of ['disable','revoke'] as const) {
    it('rejects heartbeat after '+action+' commits',async()=>{const db=fakeDb();const admin=new DeviceAdminRepository(db.pool);if(action==='disable')await admin.update('d',{enabled:false});else await admin.revoke('d');const result=await new DeviceStatusRepository(db.pool).heartbeat('d',{paused:false,battery:42},123);expect(result.accepted).toBe(false);expect(db.read().device.online).toBe(false);expect(db.read().statuses).toEqual({});});
    it('serializes '+action+' behind an in-flight heartbeat',async()=>{const db=fakeDb();db.pauseLock();const heartbeat=new DeviceStatusRepository(db.pool).heartbeat('d',{paused:false,battery:42},123);await db.lockObserved;const admin=new DeviceAdminRepository(db.pool);const change=action==='disable'?admin.update('d',{enabled:false}):admin.revoke('d');db.resume();expect((await heartbeat).accepted).toBe(true);await change;expect(db.read().device.online).toBe(false);});
  }
  it('rolls back status and online on a write error',async()=>{const db=fakeDb();db.fail();await expect(new DeviceStatusRepository(db.pool).heartbeat('d',{paused:false},123)).rejects.toThrow('injected failure');expect(db.read().device.online).toBe(false);expect(db.read().statuses).toEqual({});});
  it('reports the online transition only on the first accepted heartbeat',async()=>{const db=fakeDb();const repo=new DeviceStatusRepository(db.pool);expect(await repo.heartbeat('d',{paused:false},123)).toEqual({accepted:true,becameOnline:true});expect(await repo.heartbeat('d',{paused:false},124)).toEqual({accepted:true,becameOnline:false});});
});
