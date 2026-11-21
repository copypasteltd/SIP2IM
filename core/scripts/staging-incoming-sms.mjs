import WebSocket from 'ws';
import {ulid} from 'ulid';

// Loopback and opt-in are guardrails, not proof of isolation. See STAGING-INCOMING-SMS.md.
const origin=process.env.CORE_STAGING_ORIGIN ?? '';
const admin=process.env.CORE_STAGING_ADMIN_TOKEN ?? '';
const code=process.env.CORE_STAGING_BINDING_CODE ?? '';
const fail=()=>{throw new Error('staging operation failed');};
const validId=(value,prefix)=>typeof value==='string' && new RegExp('^'+prefix+'_[0-7][0-9A-HJKMNP-TV-Z]{25}$').test(value);
const envelope=(type,payload)=>({v:1,type,id:'evt_'+ulid(),ts:Date.now(),payload});
if(process.env.CORE_STAGING_OPT_IN!=='yes' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(origin) || Number(origin.slice(origin.lastIndexOf(':')+1))<1 || Number(origin.slice(origin.lastIndexOf(':')+1))>65535 || !admin || /[\r\n]/.test(admin) || !/^\d{6}$/.test(code)) {
 console.error('Invalid staging configuration; see STAGING-INCOMING-SMS.md.'); process.exit(1);
}
const meta={manufacturer:'VOIPGW synthetic',model:'staging-incoming-sms-'+ulid(),apiLevel:30,apkVersion:'synthetic',apkCode:1,locale:'en'};
const request=async(path,method='GET',data,auth=true)=>{
 const r=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{...(auth?{authorization:'Bearer '+admin}:{}),...(data?{'content-type':'application/json'}:{})},...(data?{body:JSON.stringify(data)}:{})});
 if(!r.ok)fail(); return r.json();
};
let socket,deviceId,bindStarted=false,eventStarted=false,passed=false,cleanupFailed=false;
const queue=[]; let waiter,socketError;
function push(value){if(waiter){const w=waiter;waiter=null;clearTimeout(w.timer);w.resolve(value);}else {if(queue.length>=32){socketError=true;return;}queue.push(value);}}
function next(){if(socketError)return Promise.reject(new Error('socket'));if(queue.length)return Promise.resolve(queue.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiter=null;reject(new Error('timeout'));},20000);waiter={resolve,reject,timer};});}
function socketFail(){socketError=true;if(waiter){const w=waiter;waiter=null;clearTimeout(w.timer);w.reject(new Error('socket'));}}
function send(value){if(socket.readyState!==WebSocket.OPEN)fail();socket.send(JSON.stringify(value));}
function requireAck(msg,id){if(msg?.v!==1||msg.type!=='ack'||msg.payload?.refId!==id||msg.payload.ok!==true||msg.payload.error!==null)fail();}
const probe={result:'untested',probedAt:Date.now(),detail:null};
const probes=Object.fromEntries(['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia'].map(k=>[k,probe]));
const snapshot=()=>envelope('status.snapshot',{sims:[{slot:0,subId:1,carrier:null,mcc:null,mnc:null,state:'ready',reportedNumber:null}],simsAuthoritative:true,capabilityLevel:'L1',probes,permissions:[]});
async function checkHistory(event,expectedId){
 const result=await request('/api/sms?deviceId='+encodeURIComponent(deviceId)+'&limit=10');
 if(!Array.isArray(result?.data)||result.data.length!==1||result.nextCursor!==null)fail();
 const row=result.data[0];
 if(!validId(row.id,'sms')||(expectedId && row.id!==expectedId)||row.deviceId!==deviceId||row.simId!==null||row.direction!=='in'||row.peer!==event.payload.from||row.peerKind!==event.payload.fromKind||row.body!==event.payload.body||row.parts!==event.payload.parts||row.occurredAt!==event.payload.receivedAt||row.task!==null)fail();
 return row.id;
}
try {
 bindStarted=true; // A lost reply may have created a device; never retry.
 const bound=await request('/api/device/bind','POST',{code,...meta},false);
 if(!validId(bound?.data?.deviceId,'dev'))fail();
 deviceId=bound.data.deviceId;
 if(typeof bound.data.token!=='string'||!bound.data.token)fail();
 socket=new WebSocket(origin.replace(/^http:/,'ws:')+'/ws/device',{handshakeTimeout:10000,maxPayload:65536,followRedirects:false});
 socket.on('error',socketFail);socket.on('close',socketFail);
 socket.on('message',data=>{try{push(JSON.parse(data.toString()));}catch{socketFail();}});
 await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('timeout')),12000);socket.once('open',()=>{clearTimeout(timer);resolve();});socket.once('error',()=>{clearTimeout(timer);reject(new Error('socket'));});});
 send(envelope('hello',{token:bound.data.token,...meta,protocol:1}));
 const hello=await next();if(hello?.v!==1||hello.type!=='hello.ok'||hello.payload?.deviceId!==deviceId)fail();
 const initial=snapshot();send(initial);requireAck(await next(),initial.id);
 const now=Date.now();
 const event=envelope('sms.received',{subId:1,slot:0,from:'synthetic-sender',fromKind:'unknown',body:'Synthetic incoming staging SMS only',receivedAt:now,parts:1});
 eventStarted=true;send(event);requireAck(await next(),event.id);
 const smsId=await checkHistory(event);
 // This is the deliberate exact replay, including the identical event timestamp.
 send(event);requireAck(await next(),event.id);await checkHistory(event,smsId);
 // Rejected conflicts receive no ACK. A subsequent ACKed snapshot is a FIFO barrier.
 send({...event,payload:{...event.payload,body:'Synthetic conflicting staging SMS only'}});
 const barrier=snapshot();send(barrier);requireAck(await next(),barrier.id);
 await checkHistory(event,smsId);
 passed=true;
} catch {
 console.error('Incoming staging SMS harness failed; response details suppressed.');
 if(bindStarted&&!deviceId)console.error('Binding outcome uncertain; inspect staging manually before any retry.');
 if(eventStarted)console.error('Incoming event may have created state; inspect staging manually; do not retry blindly.');
} finally {
 if(socket){try{socket.removeAllListeners();socket.on('error',()=>{});const closed=await new Promise(resolve=>{if(socket.readyState===WebSocket.CLOSED)return resolve(true);const timer=setTimeout(()=>resolve(false),3000);socket.once('close',()=>{clearTimeout(timer);resolve(true);});try{socket.terminate();}catch{clearTimeout(timer);resolve(false);}});if(!closed)cleanupFailed=true;}catch{cleanupFailed=true;}}
 if(deviceId){try{await request('/api/devices/'+encodeURIComponent(deviceId),'DELETE');const r=await fetch(origin+'/api/devices/'+encodeURIComponent(deviceId),{headers:{authorization:'Bearer '+admin},redirect:'error',signal:AbortSignal.timeout(10000)});if(r.status!==404)fail();}catch{cleanupFailed=true;console.error('Synthetic device revocation unconfirmed; inspect staging manually, do not retry blindly.');}}
}
if(passed&&!cleanupFailed)console.log('PASS: synthetic incoming event and exact replay ACKed, conflict unacknowledged through FIFO barrier, one null-SIM message persisted; synthetic device soft-revoked. No real SMS was received.');
else {if(cleanupFailed)console.error('Cleanup unconfirmed.');process.exitCode=1;}
