import {it,expect} from 'vitest';import {AdminHub} from '../src/ws-admin/hub.js';
it('checks authorization again before every broadcast',async()=>{let valid=true;const sent:string[]=[],closed:number[]=[];const socket={send:(v:string)=>sent.push(v),close:(v:number)=>closed.push(v)};const hub=new AdminHub(async()=>valid?'admin':null);hub.add(socket,'token');await hub.publish('device.online',{});expect(sent).toHaveLength(1);valid=false;await hub.publish('device.offline',{});expect(sent).toHaveLength(1);expect(closed).toEqual([4403]);});

it.each(['allowed','denied','error'] as const)('suppresses a superseded publication after asynchronous %s authentication',async outcome=>{
  let current=true;
  let settle!:(value:string|null)=>void, reject!:(reason:unknown)=>void;
  const authorization=new Promise<string|null>((resolve,fail)=>{settle=resolve;reject=fail;});
  let enter!:()=>void; const started=new Promise<void>(resolve=>enter=resolve);
  const hub=new AdminHub(()=>{enter();return authorization;});
  const sent:string[]=[], closed:number[]=[];
  const socket={send:(value:string)=>sent.push(value),close:(code:number)=>closed.push(code)};
  hub.add(socket,'fixture-token');
  const pending=hub.publish('channel.login.step',{ step:'code' },()=>current);
  await started; current=false;
  if(outcome==='error') reject(new Error('authorization failed')); else settle(outcome==='allowed'?'admin':null);
  await pending;
  expect(sent).toEqual([]);
  expect(closed).toEqual([]);
  await hub.stop();
});

it('does not start subscriber authentication when a readback was superseded',async()=>{
  let current=true, auth=0;
  let release!:(row:object)=>void;
  const row=new Promise<object>(resolve=>release=resolve);
  let enter!:()=>void; const started=new Promise<void>(resolve=>enter=resolve);
  const hub=new AdminHub(async()=>{++auth;return 'admin';});
  const socket={send:()=>{throw Error('stale send');},close:()=>{throw Error('unexpected close');}};
  hub.add(socket,'fixture-token');
  const pending=hub.publishLatest('channel.updated',()=>{enter();return row;},()=>current);
  await started; current=false;release({platform:'qq'});
  await pending; expect(auth).toBe(0); await hub.stop();
});
