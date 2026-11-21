import WebSocket from 'ws';
import {ulid} from 'ulid';

// Locality and opt-in are guardrails, not evidence of isolation. See STAGING-SMS.md.
const origin=process.env.CORE_STAGING_ORIGIN ?? '';
const admin=process.env.CORE_STAGING_ADMIN_TOKEN ?? '';
const code=process.env.CORE_STAGING_BINDING_CODE ?? '';
const fail=()=>{throw new Error('staging operation failed');};
const validId=(value,prefix)=>typeof value==='string' && new RegExp('^'+prefix+'_[0-7][0-9A-HJKMNP-TV-Z]{25}$').test(value);
const envelope=(type,payload)=>({v:1,type,id:'evt_'+ulid(),ts:Date.now(),payload});
if(process.env.CORE_STAGING_OPT_IN!=='yes' || !/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(origin) || Number(origin.slice(origin.lastIndexOf(':')+1))<1 || Number(origin.slice(origin.lastIndexOf(':')+1))>65535 || !admin || /[\r\n]/.test(admin) || !/^\d{6}$/.test(code)) {
 console.error('Invalid staging configuration; see STAGING-SMS.md.'); process.exit(1);
}
const meta={manufacturer:'VOIPGW synthetic',model:'staging-sms-'+ulid(),apiLevel:30,apkVersion:'synthetic',apkCode:1,locale:'en'};
const key='staging-sms-'+ulid(), body='Synthetic staging SMS only';
const request=async(path,method='GET',data,auth=true,extra={})=>{
 const r=await fetch(origin+path,{method,redirect:'error',signal:AbortSignal.timeout(10000),headers:{...(auth?{authorization:'Bearer '+admin}:{}),...(data?{'content-type':'application/json'}:{}),...extra},...(data?{body:JSON.stringify(data)}:{})});
 if(!r.ok) fail(); return r.json();
};
let socket,deviceId,bindStarted=false,smsStarted=false,passed=false,cleanupFailed=false;
// Install the queue before any operation can dispatch a command. Never discard early frames.
const queue=[]; let waiter, socketError;
function push(value){if(waiter){const w=waiter;waiter=null;clearTimeout(w.timer);w.resolve(value);}else {if(queue.length>=32){socketError=true;return;}queue.push(value);}}
function next(){if(socketError)return Promise.reject(new Error('socket'));if(queue.length)return Promise.resolve(queue.shift());return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiter=null;reject(new Error('timeout'));},20000);waiter={resolve,reject,timer};});}
function socketFail(){socketError=true;if(waiter){const w=waiter;waiter=null;clearTimeout(w.timer);w.reject(new Error('socket'));}}
function send(value){if(socket.readyState!==WebSocket.OPEN)fail();socket.send(JSON.stringify(value));}
function requireAck(msg,id){if(msg?.v!==1||msg.type!=='ack'||msg.payload?.refId!==id||msg.payload.ok!==true||msg.payload.error!==null)fail();}
async function state(taskId,messageId,simId,expected){
 for(let n=0;n<40;n++){
  const item=(await request('/api/sms/idempotency','GET',undefined,true,{'idempotency-key':key}))?.data;
  if(!item || item.id!==messageId || item.deviceId!==deviceId || item.simId!==simId || item.peer!=='12345' || item.body!==body || item.task?.id!==taskId)fail();
  if(item.task.state===expected)return;
  if(!['queued','dispatched','accepted'].includes(item.task.state))fail();
  await new Promise(resolve=>setTimeout(resolve,250));
 }
 fail();
}
try {
 bindStarted=true; // A lost reply may still have created a device. Never retry.
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
 send(envelope('heartbeat',{battery:null,charging:null,network:'unknown',signalDbm:null,shizuku:'unknown',paused:false}));
 const probe={result:'untested',probedAt:Date.now(),detail:null};
 const probes=Object.fromEntries(['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia'].map(k=>[k,probe]));
 const snapshot=envelope('status.snapshot',{sims:[{slot:0,subId:1,carrier:null,mcc:null,mnc:null,state:'ready',reportedNumber:null}],simsAuthoritative:true,capabilityLevel:'L1',probes,permissions:[]});
 send(snapshot);requireAck(await next(),snapshot.id);
 const listed=await request('/api/devices?limit=10&q='+encodeURIComponent(meta.model));
 const entries=Array.isArray(listed?.data)?listed.data.filter(x=>x.id===deviceId):[];
 const device=entries[0];
 if(entries.length!==1||listed.nextCursor!==null||device.manufacturer!==meta.manufacturer||device.model!==meta.model||device.online!==true||device.paused!==false||!Array.isArray(device.sims)||device.sims.length!==1)fail();
 const sim=device.sims[0];if(!validId(sim.id,'sim')||sim.deviceId!==deviceId||sim.slot!==0||sim.subId!==1||sim.state!=='ready'||sim.needsReview!==false)fail();
 smsStarted=true; // One POST only, including if its result is uncertain.
 const created=(await request('/api/sms','POST',{simId:sim.id,to:'12345',body},true,{'idempotency-key':key}))?.data;
 if(!validId(created?.id,'sms')||!validId(created?.task?.id,'tsk')||created.deviceId!==deviceId||created.simId!==sim.id||created.peer!=='12345'||created.body!==body)fail();
 const cmd=await next();
 if(cmd?.v!==1||cmd.type!=='sms.send'||!validId(cmd.id,'cmd')||cmd.payload?.taskId!==created.task.id||cmd.payload.slot!==0||cmd.payload.subId!==1||cmd.payload.to!=='12345'||cmd.payload.body!==body)fail();
 send(envelope('ack',{refId:cmd.id,ok:true,error:null}));
 await state(created.task.id,created.id,sim.id,'accepted');
 const result=envelope('sms.result',{taskId:created.task.id,state:'sent',errorCode:null});send(result);requireAck(await next(),result.id);
 await state(created.task.id,created.id,sim.id,'sent');
 passed=true;
} catch {
 console.error('Staging SMS harness failed; response details suppressed.');
 if(bindStarted&&!deviceId)console.error('Binding outcome uncertain; inspect staging manually before any retry.');
 if(smsStarted)console.error('SMS operation may have created state; inspect staging manually; do not retry blindly.');
} finally {
 if(socket){try{socket.removeAllListeners();socket.on('error',()=>{});const closed=await new Promise(resolve=>{if(socket.readyState===WebSocket.CLOSED)return resolve(true);const timer=setTimeout(()=>resolve(false),3000);socket.once('close',()=>{clearTimeout(timer);resolve(true);});try{socket.terminate();}catch{clearTimeout(timer);resolve(false);}});if(!closed)cleanupFailed=true;}catch{cleanupFailed=true;}}
 if(deviceId){try{await request('/api/devices/'+encodeURIComponent(deviceId),'DELETE');const r=await fetch(origin+'/api/devices/'+encodeURIComponent(deviceId),{headers:{authorization:'Bearer '+admin},redirect:'error',signal:AbortSignal.timeout(10000)});if(r.status!==404)fail();}catch{cleanupFailed=true;console.error('Synthetic device revocation unconfirmed; inspect staging manually, do not retry blindly.');}}
}
if(passed&&!cleanupFailed)console.log('PASS: synthetic SMS accepted and fake sent result persisted; socket closed and synthetic device soft-revoked. No real SMS was sent.');
else {if(cleanupFailed)console.error('Cleanup unconfirmed.');process.exitCode=1;}
