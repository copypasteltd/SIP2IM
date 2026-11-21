import {readFile} from 'node:fs/promises';
import {expect,it} from 'vitest';

it('registers reject worker cleanup for partial startup and before socket teardown',async()=>{
 const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
 const creation=source.indexOf('const rejectWorker=new RejectIntentWorker(');
 const stop='transportLifecycle.defer(()=>rejectWorker.stop(),{critical:true});';
 const first=source.indexOf(stop,creation);
 const socket=source.indexOf('transportLifecycle.defer(()=>wsCloser.start(),{critical:true});');
 const second=source.indexOf(stop,first+stop.length);
 const timer=source.indexOf('transportLifecycle.defer(()=>presence.stop(),{critical:true});');
 expect(creation).toBeGreaterThanOrEqual(0);
 expect(first).toBeGreaterThan(creation);
 expect(socket).toBeGreaterThan(first);
 expect(second).toBeGreaterThan(socket);
 expect(timer).toBeGreaterThan(second);
 expect(source.indexOf(stop,second+stop.length)).toBe(-1);
});

it('registers dispatcher cleanup for partial startup and before socket teardown',async()=>{
 const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
 const creation=source.indexOf('const dispatcher=new SmsDispatcher(');
 const stop='transportLifecycle.defer(()=>dispatcher.stop(),{critical:true});';
 const first=source.indexOf(stop,creation);
 const socket=source.indexOf('transportLifecycle.defer(()=>wsCloser.start(),{critical:true});');
 const second=source.indexOf(stop,first+stop.length);
 const timer=source.indexOf('transportLifecycle.defer(()=>presence.stop(),{critical:true});');
 expect(creation).toBeGreaterThanOrEqual(0);
 expect(first).toBeGreaterThan(creation);
 expect(socket).toBeGreaterThan(first);
 expect(second).toBeGreaterThan(socket);
 expect(timer).toBeGreaterThan(second);
 expect(source.indexOf(stop,second+stop.length)).toBe(-1);
});
