import {readFile} from 'node:fs/promises';
import {expect,it,vi} from 'vitest';
import ts from 'typescript';
import {Lifecycle} from '../src/lifecycle.js';
import {DeviceSessions} from '../src/ws-device/session.js';
import {makeDeviceEventProducer} from '../src/devices/event-producer.js';
import {AdminSessions} from '../src/ws-admin/session.js';

const deferred = <T>() => { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
const socket = () => ({send:vi.fn(),close:vi.fn()});

it('wires shared registries and drains them after interval and workers, before socket cleanup',async()=>{
  const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
  expect(source).toContain('adminSessions.open(connection,token=>hub.add(connection,token),()=>hub.remove(connection))');
  expect(source).toContain(': sessions.open(connection)');
  expect(source).not.toContain('openAdminSession(');
 expect(source).toContain("stopping.addEventListener('abort', () => { void dispatcher.stop(); }, { once: true });");
 expect(source).toContain("stopping.addEventListener('abort', () => { void activeSmsRateRuntime.stop(); }, { once: true });");
 expect(source).toContain('flush: (id, rate) => stopping.aborted ? Promise.resolve() : dispatcher.flush(id, rate)');
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

it('wakes SMS only for a committed snapshot on the current attachment and before shutdown',async()=>{
 const source=await readFile(new URL('../src/main.ts',import.meta.url),'utf8');
 const ast=ts.createSourceFile('main.ts',source,ts.ScriptTarget.Latest,true);
 let initializer: string | undefined;
 const visit=(node:ts.Node):void=>{
  if(ts.isVariableDeclaration(node)&&node.name.getText(ast)==='sessions'&&node.initializer&&ts.isNewExpression(node.initializer)){
   const options=node.initializer.arguments?.[0];
   if(options&&ts.isObjectLiteralExpression(options)){
    const property=options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(ast)==='onEvent');
    if(property&&ts.isPropertyAssignment(property))initializer=property.initializer.getText(ast);
   }
  }
  ts.forEachChild(node,visit);
 };
 visit(ast); expect(initializer).toBeTypeOf('string');
 const js=ts.transpileModule('const onEvent='+initializer+';\nreturn onEvent;', {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const controller=new AbortController();
 const gates=Array.from({length:3},()=>({entered:deferred<void>(),commit:deferred<'inserted'>()}));
 const events={handle:vi.fn(async()=>{const gate=gates[events.handle.mock.calls.length-1]!;gate.entered.resolve(undefined);return gate.commit.promise;})};
 const request=vi.fn();
 const onEvent=new Function('stopping','makeDeviceEventProducer','events','smsRateRuntime','flushIncoming','flushSmsTasks',js)(
  controller.signal,makeDeviceEventProducer,events,{request},vi.fn(),vi.fn(),
 ) as ConstructorParameters<typeof DeviceSessions>[0]['onEvent'];
 const id='dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
 const sessions=new DeviceSessions({authenticate:async()=>({id,enabled:true}),heartbeat:async()=>{},onEvent,heartbeatSec:30,locale:'en'});
 const a=socket(), b=socket(), older=sessions.open(a), current=sessions.open(b);
 const hello=JSON.stringify({v:1,type:'hello',id:'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV',ts:1,payload:{token:'fixture',apkVersion:'1',apkCode:1,protocol:1,manufacturer:'x',model:'x',apiLevel:19,locale:'en'}});
 const probes=Object.fromEntries(['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia']
  .map(name=>[name,{result:'untested',probedAt:1,detail:null}]));
 const snapshot=(n:number)=>JSON.stringify({v:1,type:'status.snapshot',id:'evt_'+String(n).padStart(26,'0'),ts:n,payload:{sims:[],capabilityLevel:'L1',probes,permissions:[]}});
 try {
  await older.message(hello);
  const stale=older.message(snapshot(1)); await gates[0]!.entered.promise;
  expect(request).not.toHaveBeenCalled();
  await current.message(hello);
  gates[0]!.commit.resolve('inserted'); await stale;
  expect(request).not.toHaveBeenCalled();
  expect(a.send.mock.calls.map(([message])=>JSON.parse(message).type)).toEqual(['hello.ok']);

  const live=current.message(snapshot(2)); await gates[1]!.entered.promise;
  expect(request).not.toHaveBeenCalled();
  gates[1]!.commit.resolve('inserted'); await live;
  expect(request.mock.calls).toEqual([[id]]);
  expect(b.send.mock.calls.map(([message])=>JSON.parse(message).type)).toEqual(['hello.ok','ack']);

  const stopping=current.message(snapshot(3)); await gates[2]!.entered.promise;
  controller.abort(); gates[2]!.commit.resolve('inserted'); await stopping;
  expect(request.mock.calls).toEqual([[id]]);
 } finally { gates.forEach(gate=>gate.commit.resolve('inserted')); await sessions.stop(); }
});
