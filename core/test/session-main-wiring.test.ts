import {readFile} from 'node:fs/promises';
import {expect,it,vi} from 'vitest';
import ts from 'typescript';
import {Lifecycle} from '../src/lifecycle.js';
import {DeviceSessions} from '../src/ws-device/session.js';
import {AdminSessions} from '../src/ws-admin/session.js';

const deferred = <T>() => { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
const socket = () => ({send:vi.fn(),close:vi.fn()});

it('wires shared registries and drains them after interval and workers, before socket cleanup',async()=>{
  const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  expect(source).toContain('adminSessions.open(connection,token=>hub.add(connection,token),()=>hub.remove(connection))');
  expect(source).toContain(': sessions.open(connection)');
  expect(source).not.toContain('openAdminSession(');
  const early=source.indexOf('transportLifecycle.defer(stopSessions,{critical:true});');
  const ws=source.indexOf('transportLifecycle.defer(()=>wsCloser.start(),{critical:true});');
  const late=source.indexOf('transportLifecycle.defer(stopSessions,{critical:true});',early+1);
  const worker=source.indexOf('transportLifecycle.defer(()=>rejectWorker.stop(),{critical:true});',late);
  const dispatcher=source.indexOf('transportLifecycle.defer(()=>dispatcher.stop(),{critical:true});',late);
  const presence=source.indexOf('transportLifecycle.defer(()=>presence.stop(),{critical:true});');
  expect(early).toBeGreaterThan(source.indexOf('const adminSessions=new AdminSessions('));
  expect(late).toBeGreaterThan(early); expect(ws).toBeGreaterThan(late);
  expect(worker).toBeGreaterThan(late); expect(dispatcher).toBeGreaterThan(late);
  expect(presence).toBeGreaterThan(worker); expect(presence).toBeGreaterThan(dispatcher);

  // Execute the actual stop function from main.ts against real registries and fake sockets.
  const match=source.match(/const stopSessions=async\(\)=>\{[\s\S]*?\n\};/) ;
  expect(match).not.toBeNull();
  const js=ts.transpileModule(match![0]+'\nreturn stopSessions;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const deviceAuth=deferred<{id:string;enabled:boolean}|null>(),adminAuth=deferred<string|null>();
  const sessions=new DeviceSessions({authenticate:()=>deviceAuth.promise,heartbeat:async()=>{},onEvent:async()=>true,heartbeatSec:30,locale:'en'});
  const adminSessions=new AdminSessions(()=>adminAuth.promise);
  const d=socket(),a=socket(),device=sessions.open(d),admin=adminSessions.open(a);
  const hello=JSON.stringify({v:1,type:'hello',id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload:{token:'x',apkVersion:'1',apkCode:1,protocol:1,manufacturer:'x',model:'x',apiLevel:19,locale:'en'}});
  const deviceWork=device.message(hello),adminWork=admin.message(JSON.stringify({type:'auth',token:'x'}));
  await Promise.resolve();
  const stopSessions=new Function('sessions','adminSessions',js)(sessions,adminSessions) as ()=>Promise<void>;
  const order:string[]=[]; const lifecycle=new Lifecycle();
  lifecycle.defer(()=>{order.push('socket');}); lifecycle.defer(stopSessions,{critical:true});
  lifecycle.defer(()=>{order.push('worker');}); lifecycle.defer(()=>{order.push('interval');});
  const closing=lifecycle.close();
  await vi.waitFor(()=>expect(order).toEqual(['interval','worker']));
  const lateDevice=socket(),lateAdmin=socket(); sessions.open(lateDevice); adminSessions.open(lateAdmin);
  expect(lateDevice.close).toHaveBeenCalledWith(1001); expect(lateAdmin.close).toHaveBeenCalledWith(1001);
  deviceAuth.resolve(null); await deviceWork;
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(order).toEqual(['interval','worker']);
  adminAuth.resolve(null); await Promise.all([adminWork,closing]);
  expect(order).toEqual(['interval','worker','socket']);
});

it('attempts both registry stops and reports failures after both settle',async()=>{
  const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  const body=source.match(/const stopSessions=async\(\)=>\{[\s\S]*?\n\};/) ![0];
  const js=ts.transpileModule(body+'\nreturn stopSessions;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const gate=deferred<void>(),failure=new Error('device stop failed');
  const sessions={stop:vi.fn(()=>{throw failure;})},adminSessions={stop:vi.fn(()=>gate.promise)};
  const stop=new Function('sessions','adminSessions',js)(sessions,adminSessions) as ()=>Promise<void>;
  const result=stop(); const check=expect(result).rejects.toMatchObject({errors:[failure]});
  await vi.waitFor(()=>expect(adminSessions.stop).toHaveBeenCalledOnce());
  gate.resolve(); await check;
});
