import {initiateCall,createProbeSession} from './live.mjs';
export async function openProbe({port,deviceId,simId,to,WebSocketImpl,fetcher=fetch,setIntervalFn=setInterval,clearIntervalFn=clearInterval}) {
 if(!Number.isInteger(port)||port<1||port>65535)throw Error('invalid port');
 const origin='http://127.0.0.1:'+port;
 const leg=await initiateCall({deviceId,simId,to,post:async(path,body)=>{const r=await fetcher(origin+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),redirect:'error'});if(!r.ok)throw Error('probe HTTP '+r.status);return r.json();}});
 const url=new URL(leg.mediaPath,origin);if(url.origin!==origin)throw Error('invalid media origin');url.protocol='ws:';
 const socket=new WebSocketImpl(url);let timer;const session=createProbeSession({send:data=>socket.send(data)});
 socket.on('open',()=>{session.authenticate(leg.mediaToken);timer=setIntervalFn(()=>session.sendTone(),20);});
 socket.on('message',(data,isBinary)=>{if(isBinary)session.receive(data);});socket.on('close',()=>{if(timer)clearIntervalFn(timer);});socket.on('error',()=>{});
 return {close(){if(timer)clearIntervalFn(timer);socket.close();},report:()=>session.report(),wav:()=>session.wav()};
}
