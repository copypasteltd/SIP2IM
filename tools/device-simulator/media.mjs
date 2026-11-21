import {toneFrame} from '../audio-probe/probe.mjs';
export function openDeviceMedia({server,leg,token,WebSocketImpl,setIntervalFn=setInterval,clearIntervalFn=clearInterval,clock=Date.now,silent=false}) {
 if(!leg || typeof leg.path!=='string' || !leg.path.startsWith('/ws/media?') || leg.format!==2 || !token) throw Error('invalid media leg');
 const url=new URL(leg.path,server);const base=new URL(server);if(url.origin!==base.origin)throw Error('media must use server origin');
 const socket=new WebSocketImpl(url,{headers:{Authorization:'Bearer '+token}});let timer,seq=0,sent=0,received=0,closed=false;
 try {
  socket.on('open',()=>{if(closed)return;timer=setIntervalFn(()=>{const frame=toneFrame(seq++ >>> 0,clock()>>>0,silent?0:10000);socket.send(frame);sent++;},20);});
  socket.on('message',()=>{received++;});socket.on('close',()=>{closed=true;if(timer){clearIntervalFn(timer);timer=null;}});socket.on('error',()=>{});
 } catch (error) { try { socket.close(); } catch {} throw error; }
 return {close(){if(closed)return;closed=true;if(timer){clearIntervalFn(timer);timer=null;}socket.close();},report(){return {sent,received};}};
}
