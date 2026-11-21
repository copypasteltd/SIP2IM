import { describe, it, expect, vi } from 'vitest';
import { encodeMediaFrame } from '@voipgw/protocol';
import { MediaTransport } from '../src/media/transport.js';
const url='/ws/media?session=s&leg=l';
const socket=()=>({bufferedAmount:0,send:vi.fn(),close:vi.fn()});
const bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value));
const frame=()=>encodeMediaFrame({format:2,flags:0,seq:0,captureTs:0,pcm:new Uint8Array(640)});
describe('authenticated media transport (fake sockets)',()=>{
 it('consumes browser tokens once and only delivers authenticated binary frames',()=>{
  const t=new MediaTransport(async()=>null), {leg,mediaToken}=t.provision('s','l',{kind:'browser'}), a=socket(), b=socket();
  const first=t.open(a,url); first.message(bytes({type:'auth',token:mediaToken}),false); first.message(frame(),true); expect(leg.format).toBe(2);
  const second=t.open(b,url); second.message(bytes({type:'auth',token:mediaToken}),false); expect(b.close).toHaveBeenCalledWith(4403);
  leg.write(new Uint8Array(640),0,0); expect(a.send).toHaveBeenCalledOnce(); t.close(); expect(a.close).toHaveBeenCalledWith(4404);
 });
 it('checks device owner, replaces only after authentication, and rejects URL tokens',async()=>{
  const t=new MediaTransport(async token=>token==='good'?{id:'d',enabled:true}:null); t.provision('s','l',{kind:'device',deviceId:'d'});
  const a=socket(), b=socket(), bad=socket(), leaked=socket(); const first=t.open(a,url,'Bearer good'); await vi.waitFor(()=>expect(a.close).not.toHaveBeenCalled()); await Promise.resolve();
  const invalid=t.open(bad,url,'Bearer bad'); await vi.waitFor(()=>expect(bad.close).toHaveBeenCalledWith(4403)); expect(a.close).not.toHaveBeenCalled();
  const second=t.open(b,url,'Bearer good'); await vi.waitFor(()=>expect(a.close).toHaveBeenCalledWith(4409)); first.close(); second.message(frame(),true);
  t.open(leaked,url+'&token=secret'); expect(leaked.close).toHaveBeenCalledWith(4403); invalid.close(); t.close();
 });
 it('fails closed if a leg is revoked while device authentication is pending',async()=>{
  let resolve!:(v:{id:string;enabled:boolean})=>void; const t=new MediaTransport(()=>new Promise(r=>{resolve=r;})); const {leg}=t.provision('s','l',{kind:'device',deviceId:'d'}); const s=socket(), session=t.open(s,url,'Bearer good'); session.message(frame(),true); t.revoke('s','l'); resolve({id:'d',enabled:true}); await vi.waitFor(()=>expect(s.close).toHaveBeenCalledWith(4404)); expect(leg.format).toBeUndefined();
 });
 it('resets jitter on device reconnection without replacing the routed leg or renegotiating format',async()=>{
  const t=new MediaTransport(async()=>({id:'d',enabled:true})); const {leg}=t.provision('s','l',{kind:'device',deviceId:'d'}); const a=socket(),b=socket(); const first=t.open(a,url,'Bearer good'); await Promise.resolve();
  for(let seq=100;seq<106;seq++) first.message(encodeMediaFrame({format:2,flags:0,seq,captureTs:0,pcm:new Uint8Array(640)}),true);
  expect(leg.jitter.pop()?.seq).toBe(100); const second=t.open(b,url,'Bearer good'); await Promise.resolve(); expect(a.close).toHaveBeenCalledWith(4409); expect(leg.jitter.size).toBe(0);
  for(let seq=0;seq<6;seq++) second.message(encodeMediaFrame({format:2,flags:0,seq,captureTs:0,pcm:new Uint8Array(640)}),true);
  expect(leg.jitter.pop()?.seq).toBe(0); first.close(); second.message(encodeMediaFrame({format:1,flags:0,seq:4,captureTs:0,pcm:new Uint8Array(320)}),true); expect(leg.closed).toBe(true); t.close();
 });
 it('limits pending empty frames and clears them after rejection',async()=>{
  let resolve!:(v:{id:string;enabled:boolean})=>void; const t=new MediaTransport(()=>new Promise(r=>{resolve=r;})); const {leg}=t.provision('s','l',{kind:'device',deviceId:'d'}); const s=socket(), session=t.open(s,url,'Bearer good');
  for(let i=0;i<65;i++) session.message(new Uint8Array(),true); expect(s.close).toHaveBeenCalledWith(4403); resolve({id:'d',enabled:true}); await Promise.resolve(); expect(leg.closed).toBe(false); expect(leg.format).toBeUndefined(); t.close();
 });
 it('does not let older successful authentication displace a newer one',async()=>{
  const resolvers:((v:{id:string;enabled:boolean})=>void)[]=[]; const t=new MediaTransport(()=>new Promise(r=>resolvers.push(r))); t.provision('s','l',{kind:'device',deviceId:'d'}); const a=socket(),b=socket(); t.open(a,url,'Bearer good'); t.open(b,url,'Bearer good');
  resolvers[1]!({id:'d',enabled:true}); await Promise.resolve(); resolvers[0]!({id:'d',enabled:true}); await Promise.resolve(); expect(a.close).toHaveBeenCalledWith(4409); expect(b.close).not.toHaveBeenCalled(); t.close();
 });
 it('revokes pending and connected device sockets and drops congested output',async()=>{
  let resolve!:(v:{id:string;enabled:boolean})=>void; const t=new MediaTransport(token=>token==='pending'?new Promise(r=>{resolve=r;}):Promise.resolve({id:'d',enabled:true})); const {leg}=t.provision('s','l',{kind:'device',deviceId:'d'}); const active=socket(), pending=socket(); const a=t.open(active,url,'Bearer good'); await Promise.resolve(); a.message(frame(),true); active.bufferedAmount=65537; leg.write(new Uint8Array(640),0,0); expect(active.send).not.toHaveBeenCalled();
  t.open(pending,url,'Bearer pending'); t.revokeDevice('d'); expect(active.close).toHaveBeenCalledWith(4404); expect(pending.close).toHaveBeenCalledWith(4404); resolve({id:'d',enabled:true}); await Promise.resolve(); expect(leg.closed).toBe(true);
 });
 it('closes admission immediately and drains outstanding authentication',async()=>{
  let resolve!:(v:{id:string;enabled:boolean})=>void; const auth=vi.fn(()=>new Promise<{id:string;enabled:boolean}>(r=>{resolve=r;}));
  const t=new MediaTransport(auth), {leg}=t.provision('s','l',{kind:'device',deviceId:'d'}), s=socket();
  const session=t.open(s,url,'Bearer good'); session.message(frame(),true); t.close(); t.close();
  expect(s.close).toHaveBeenCalledOnce(); expect(s.close).toHaveBeenCalledWith(4404);
  expect(()=>t.provision('s','other',{kind:'browser'})).toThrow(); const late=socket(); t.open(late,url,'Bearer good'); expect(late.close).toHaveBeenCalledWith(4404); expect(auth).toHaveBeenCalledOnce();
  let drained=false; const drain=t.drain().then(()=>{drained=true;}); await Promise.resolve(); expect(drained).toBe(false);
  resolve({id:'d',enabled:true}); await drain; expect(leg.format).toBeUndefined(); expect(drained).toBe(true);
 });
 it('drains rejected and synchronously throwing authenticators',async()=>{
  const t=new MediaTransport(()=>{throw new Error('failure');}); t.provision('s','l',{kind:'device',deviceId:'d'}); const s=socket();
  expect(()=>t.open(s,url,'Bearer bad')).not.toThrow(); t.close(); await t.drain(); expect(s.close).toHaveBeenCalledOnce();
 });
 it('attempts every close and reports errors without losing pending authentication',async()=>{
  let resolve!:(v:{id:string;enabled:boolean})=>void; const t=new MediaTransport(()=>new Promise(r=>{resolve=r;}));
  const first=t.provision('s','l',{kind:'device',deviceId:'d'}), second=t.provision('s','other',{kind:'browser'});
  const bad=socket(), pending=socket(), good=socket(); bad.close.mockImplementation(()=>{throw new Error('close failed');});
  t.open(bad,url); t.open(pending,url,'Bearer good'); t.open(good,'/ws/media?session=s&leg=other');
  expect(()=>t.close()).toThrow(AggregateError); expect(bad.close).toHaveBeenCalledWith(4404); expect(pending.close).toHaveBeenCalledWith(4404); expect(good.close).toHaveBeenCalledWith(4404);
  expect(first.leg.closed).toBe(true); expect(second.leg.closed).toBe(true);
  let drained=false; const drain=t.drain().then(()=>{drained=true;}); await Promise.resolve(); expect(drained).toBe(false); resolve({id:'d',enabled:true}); await drain; expect(drained).toBe(true);
 });
 it('closes unauthenticated sockets and rejects missing legs',()=>{
  vi.useFakeTimers(); try {const t=new MediaTransport(async()=>null); t.provision('s','l',{kind:'browser'}); const a=socket(), b=socket(); t.open(a,url); t.open(b,'/ws/media?session=x&leg=l'); expect(b.close).toHaveBeenCalledWith(4404); vi.advanceTimersByTime(5000); expect(a.close).toHaveBeenCalledWith(4401); t.close();} finally {vi.useRealTimers();}
 });
});
