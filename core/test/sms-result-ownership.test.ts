import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {DeviceEvents} from '../src/devices/events.js';
import {makeDeviceEventProducer} from '../src/devices/event-producer.js';
it('rejects unowned or missing tasks before storing, acknowledging, or publishing',async()=>{
 const query=vi.fn(async(sql:string)=>sql==='COMMIT'||sql==='ROLLBACK'?{rowCount:0,rows:[],command:sql}:sql.startsWith('SELECT id FROM device WHERE id=$1 AND enabled=true')?{rowCount:1,rows:[{id:'device'}]}:sql.startsWith('SELECT t.id FROM sms_task')?{rowCount:0,rows:[]}:{rowCount:0,rows:[]});
 const events=new DeviceEvents({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
 const taskUpdated=vi.fn();const producer=makeDeviceEventProducer({handle:(id,event)=>events.handle(id,event),readSms:async()=>null,publish:async()=>{},taskUpdated});
 expect(await producer('other-device',{id:'event',type:'sms.result',ts:1,payload:{taskId:'victim',state:'sent',errorCode:null}})).toBe(false);
 expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO device_event'))).toBe(false);
 expect(taskUpdated).not.toHaveBeenCalled();
});
it('rejects the Core-reserved conflict code before insertion',async()=>{
 const query=vi.fn(async(sql:string)=>sql==='COMMIT'||sql==='ROLLBACK'?{rowCount:0,rows:[],command:sql}:{rowCount:1,rows:[{id:'task'}]});
 const service=new DeviceEvents({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
 expect(await service.handle('device',{id:'event',type:'sms.result',ts:1,payload:{taskId:'task',state:'failed',errorCode:'SMS_RESULT_CONFLICT'}})).toBe('rejected');
 expect(query.mock.calls.some(([sql])=>sql.startsWith('INSERT INTO device_event'))).toBe(false);
});
