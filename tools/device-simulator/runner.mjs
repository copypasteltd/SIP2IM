import {createDevice} from './device.mjs';

export async function bindDevice(server, code, fetcher=fetch) {
 const base=new URL(server); if(!['ws:','wss:'].includes(base.protocol)) throw Error('server must use ws or wss');
 base.protocol=base.protocol==='wss:'?'https:':'http:'; base.pathname='/api/device/bind'; base.search='';
 const response=await fetcher(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,manufacturer:'Simulator',model:'Virtual',apiLevel:34,apkVersion:'0.1.0',apkCode:1,locale:'en'}),redirect:'error'});
 if(!response.ok) throw Error('binding HTTP '+response.status); const result=await response.json();
 if(!result?.data?.deviceId || !result?.data?.token) throw Error('invalid binding response'); return result.data;
}
export function createSession({token,send,now=Date.now,simCount=1,openMedia}) {
 const device=createDevice({token,now,simCount}); const pending=new Map(),counts={sent:0,received:0,errors:0},latencies=[]; let ready=false, media=null;
 function transmit(evt,queue=false){if(queue) pending.set(evt.id,evt);send(JSON.stringify(evt));counts.sent++;}
 function start(){ready=false;transmit(device.hello());}
 function receive(raw){counts.received++;let msg;try{msg=JSON.parse(raw);}catch{counts.errors++;return;}
  if(msg.type==='hello.ok'){ready=true;transmit(device.snapshot());for(const event of pending.values()) if(!event.type.startsWith('call.') || now()-event.ts<60000) transmit(event);else pending.delete(event.id);return;}
  if(msg.type==='ack'){if(msg.payload?.ok && pending.has(msg.payload.refId)){latencies.push(now()-pending.get(msg.payload.refId).ts);pending.delete(msg.payload.refId);}return;}
  try{const events=device.command(msg,leg=>{if(!openMedia) throw Error('media unavailable');media=openMedia(leg);});if(events.length>1 && events[0].payload.ok && (msg.type==='call.hangup'||msg.type==='call.reject')) { const old=media;media=null;try{old?.close();}catch{counts.errors++;} } for(const event of events)transmit(event,event.type==='sms.result'||event.type==='call.state');}catch{counts.errors++;}
 }
 return {start,receive,close:()=>{ready=false;media?.close();media=null;},heartbeat:()=>{if(ready)transmit(device.heartbeat());},sms:(from,body)=>{const e=device.sms(from,body);pending.set(e.id,e);if(ready)transmit(e);},incoming:(id,from)=>{const e=device.incoming(id,from);pending.set(e.id,e);if(ready)transmit(e);},report:()=>({...counts,pending:pending.size,latenciesMs:[...latencies]})};
}
