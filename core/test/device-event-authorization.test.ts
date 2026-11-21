import {describe,it,expect} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';

const types=['status.snapshot','sms.received','sms.result','call.incoming','call.state'];
describe('event authorization under device lock',()=>{
  for(const type of types) for(const reason of ['disabled','revoked','missing']) {
    it('rejects '+type+' for '+reason+' even if it is a duplicate',async()=>{
      const calls:string[]=[];
      const client={query:async(sql:string)=>{calls.push(sql);if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};if(sql.startsWith('SELECT id FROM device WHERE'))return {rowCount:0,rows:[]};if(sql.startsWith('SELECT device_id=$2'))return {rowCount:1,rows:[{matches:true}]};return {rowCount:0,rows:[]};},release:()=>{}};
      const events=new DeviceEvents({connect:async()=>client} as unknown as pg.Pool);
      expect(await events.handle('d',{id:'existing',type,ts:1,payload:{}})).toBe('rejected');
      const authorization = 'SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE';
      expect(calls.filter(q=>!q.startsWith('SET '))[1]).toBe(authorization);
      expect(calls.some(q=>q.startsWith('INSERT')||q.startsWith('UPDATE')||q.startsWith('SELECT device_id=$2'))).toBe(false);
      expect(calls.at(-1)).toBe('COMMIT');
    });
  }
  it('serializes revocation after an event holding the device row lock',async()=>{
    let eventRelease!:()=>void;let signalLocked!:()=>void;let resumeEvent!:()=>void;
    const locked=new Promise<void>(r=>{signalLocked=r;});const gate=new Promise<void>(r=>{resumeEvent=r;});
    let available=Promise.resolve();let revoked=false;let inserted=false;
    const acquire=async()=>{const previous=available;let release!:()=>void;available=new Promise<void>(r=>{release=r;});await previous;return release;};
    const client={query:async(sql:string)=>{
      if(sql.startsWith('SELECT id FROM device WHERE')){const release=await acquire();eventRelease=release;signalLocked();await gate;if(revoked){release();return {rowCount:0,rows:[]};}return {rowCount:1,rows:[{id:'d'}]};}
      if(sql.startsWith('INSERT INTO device_event')){inserted=true;return {rowCount:1,rows:[{id:'e'}]};}
      if(sql==='COMMIT'||sql==='ROLLBACK'){eventRelease();return {rowCount:0,rows:[],command:sql};}
      return {rowCount:0,rows:[]};},release:()=>{}};
    const service=new DeviceEvents({connect:async()=>client} as unknown as pg.Pool);
    const processing=service.handle('d',{id:'e',type:'status.snapshot',ts:1,payload:{sims:[],capabilityLevel:'L1',probes:{},permissions:[]}});
    await locked;const revoke=(async()=>{const release=await acquire();revoked=true;release();})();resumeEvent();
    expect(await processing).toBe('inserted');await revoke;expect(inserted).toBe(true);expect(revoked).toBe(true);
  });
  it('checks authorization before the sms task lock and accepts an authorized duplicate',async()=>{
    const calls:string[]=[];const client={query:async(sql:string)=>{calls.push(sql);if(sql==='COMMIT'||sql==='ROLLBACK')return {rowCount:0,rows:[],command:sql};if(sql.startsWith('SELECT id FROM device WHERE')||sql.startsWith('SELECT t.id FROM sms_task'))return {rowCount:1,rows:[{id:'d'}]};if(sql.startsWith('INSERT INTO device_event'))return {rowCount:0,rows:[]};if(sql.startsWith('SELECT device_id=$2'))return {rowCount:1,rows:[{matches:true}]};return {rowCount:0,rows:[]};},release:()=>{}};
    expect(await new DeviceEvents({connect:async()=>client} as unknown as pg.Pool).handle('d',{id:'existing',type:'sms.result',ts:1,payload:{taskId:'task'}})).toBe('duplicate');
    expect(calls.findIndex(q=>q.startsWith('SELECT id FROM device WHERE'))).toBeLessThan(calls.findIndex(q=>q.startsWith('SELECT t.id FROM sms_task')));
  });
});
