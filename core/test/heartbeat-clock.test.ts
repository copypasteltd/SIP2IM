import {describe,it,expect} from 'vitest';
import type pg from 'pg';
import {DeviceStatusRepository} from '../src/devices/repo.js';

// Transactional fake: models row ordering and rollback without a database.
function fake(now:number, initial:Record<string,{value:unknown; observed:number; received:number}>={}) {
  let rows=structuredClone(initial), device={online:false,paused:true,lastSeen:0};
  const connect=async()=>{let next=structuredClone(rows), d={...device};return {release(){},async query(sql:string,p:unknown[]=[]){
    if(sql==='BEGIN')return {rows:[]};
    if(sql==='COMMIT'){rows=next;device=d;return {rows:[],command:'COMMIT'};}
    if(sql==='ROLLBACK')return {rows:[],command:'ROLLBACK'};
    if(sql.includes('FOR UPDATE'))return {rows:[{enabled:true,revoked_at:null,online:d.online}]};
    if(sql.includes('clock_timestamp()'))return {rows:[{received_at:new Date(now)}]};
    if(sql.startsWith('INSERT INTO device_status')){const field=String(p[1]), at=(p[3] as Date).getTime(),old=next[field];if(!p[6] && old && old.observed<=old.received && (old.observed>at || (old.observed===at && JSON.stringify(old.value)!==JSON.stringify(JSON.parse(String(p[2]))))))return {rows:[],rowCount:0}; next[field]={value:JSON.parse(String(p[2])),observed:at,received:(p[5] as Date).getTime()};return {rows:[{field}],rowCount:1};}
    if(sql.startsWith('UPDATE device SET online=true')){d.online=true;d.lastSeen=(p[3] as Date).getTime();if(p[2])d.paused=p[1] as boolean;return {rows:[],rowCount:1};}
    throw new Error('Unexpected SQL: '+sql);
  }};};
  return {pool:{connect} as unknown as pg.Pool,read:()=>({rows,device}),advance:(ms:number)=>{now+=ms;}};
}
const now=1_000_000_000;
describe('heartbeat clock authority',()=>{
  it('clamps a modest future clock to receipt and keeps pause coherent',async()=>{const db=fake(now);await new DeviceStatusRepository(db.pool).heartbeat('d',{paused:false,network:'wifi'},now+60_000);expect(db.read()).toMatchObject({device:{online:true,paused:false,lastSeen:now},rows:{network:{value:'wifi',observed:now,received:now},paused:{value:false,observed:now}}});});
  it('keeps an old heartbeat old and forces paused without reviving status',async()=>{const db=fake(now);await new DeviceStatusRepository(db.pool).heartbeat('d',{paused:false,network:'wifi'},now-120_000);expect(db.read()).toMatchObject({device:{online:true,paused:true},rows:{network:{value:'wifi',observed:now-120_000},paused:{value:true}}});});
  it('marks extreme skew unknown while retaining receipt liveness',async()=>{for(const at of [now+300_001,now-7_200_001,Number.MAX_VALUE]){const db=fake(now);await new DeviceStatusRepository(db.pool).heartbeat('d',{paused:false,network:'wifi'},at);expect(db.read()).toMatchObject({device:{online:true,paused:true},rows:{network:{value:null,observed:now},paused:{value:true}}});}});
  it('recovers after a suspect heartbeat when the clock is corrected',async()=>{const db=fake(now);const repo=new DeviceStatusRepository(db.pool);await repo.heartbeat('d',{network:'wifi',paused:false},now+300_001);await repo.heartbeat('d',{network:'wifi',paused:false},now-30_000);expect(db.read()).toMatchObject({device:{paused:true},rows:{network:{value:null,observed:now},paused:{value:true}}});});
  it('clears a forced pause once a corrected clock reaches its receipt time',async()=>{const db=fake(now);const repo=new DeviceStatusRepository(db.pool);await repo.heartbeat('d',{paused:false},now+300_001);await repo.heartbeat('d',{paused:false},now-30_000);expect(db.read().device.paused).toBe(true);await repo.heartbeat('d',{paused:false},now);expect(db.read().device.paused).toBe(true);db.advance(1);await repo.heartbeat('d',{paused:false},now+1);expect(db.read().device.paused).toBe(false);});
  it('does not replace newer unknown with an older fresh value',async()=>{const db=fake(now);const repo=new DeviceStatusRepository(db.pool);await repo.heartbeat('d',{network:'wifi',paused:false},now+300_001);await repo.heartbeat('d',{network:'wifi',paused:false},now-1000);expect(db.read().rows.network?.value).toBeNull();});
  it('rejects equal-time unknown replacement while accepting identical repeats',async()=>{const db=fake(now,{network:{value:null,observed:now-1000,received:now-1000}});const repo=new DeviceStatusRepository(db.pool);await repo.heartbeat('d',{network:'wifi'},now-1000);expect(db.read().rows.network).toEqual({value:null,observed:now-1000,received:now-1000});await repo.heartbeat('d',{network:null},now-1000);expect(db.read().rows.network).toEqual({value:null,observed:now-1000,received:now});});
  it('applies a recent paused true despite a newer previous observation',async()=>{const db=fake(now,{paused:{value:false,observed:now-1000,received:now-1000}});await new DeviceStatusRepository(db.pool).heartbeat('d',{paused:true},now-2000);expect(db.read()).toMatchObject({device:{paused:true},rows:{paused:{value:true,observed:now}}});});
  it('does not let an older heartbeat clear pause or replace newer network',async()=>{const db=fake(now,{paused:{value:true,observed:now-1000,received:now-1000},network:{value:'cellular',observed:now-1000,received:now-1000}});await new DeviceStatusRepository(db.pool).heartbeat('d',{network:'wifi',paused:false},now-2000);expect(db.read()).toMatchObject({device:{paused:true},rows:{network:{value:'cellular'},paused:{value:true}}});});
  it('replaces poisoned future rows without clearing newer pause state',async()=>{const db=fake(now,{network:{value:'bad',observed:now+500_000,received:now-500_000},paused:{value:true,observed:now-1000,received:now-1000}});await new DeviceStatusRepository(db.pool).heartbeat('d',{network:'wifi',paused:false},now-2000);expect(db.read()).toMatchObject({device:{paused:true},rows:{network:{value:'wifi',observed:now-2000},paused:{value:true}}});});
});
