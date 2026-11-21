import { randomBytes } from 'node:crypto';

function ulid(now) {
  const alphabet='0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let value=(BigInt(now) << 80n) | BigInt('0x' + randomBytes(10).toString('hex'));
  let result=''; for (let i=0;i<26;i++) { result=alphabet[Number(value & 31n)]+result; value >>= 5n; }
  return result;
}
export function envelope(type, payload, now = Date.now()) {
  return { v: 1, type, id: 'evt_' + ulid(now), ts: now, payload };
}
export function snapshot(count = 1, now = Date.now()) {
  if (count !== 1 && count !== 2) throw new RangeError('SIM count must be 1 or 2');
  const probes = Object.fromEntries(['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia'].map(k => [k,{ result:'untested', probedAt:now, detail:null }]));
  return { sims: Array.from({length:count}, (_,slot) => ({slot,subId:slot+1,carrier:null,state:'ready',reportedNumber:null,mcc:null,mnc:null})), capabilityLevel:'L1', probes, permissions:[] };
}
export function createDevice({ token, simCount = 1, now = Date.now }) {
  if (typeof token !== 'string' || !token) throw new TypeError('token is required');
  const cache = new Map(); let call = null;
  const emit = (type,payload) => envelope(type,payload,now());
  const hello = () => emit('hello',{token,apkVersion:'0.1.0',apkCode:1,protocol:1,manufacturer:'Simulator',model:'Virtual',apiLevel:34,locale:'en'});
  const heartbeat = () => emit('heartbeat',{battery:100,charging:true,network:'wifi',signalDbm:null,shizuku:'unknown',paused:false});
  const state = (callId,state,cause=null) => emit('call.state',{callId,state,cause});
  function command(message, startMedia = () => {}) {
    if (!message || message.v !== 1 || typeof message.id !== 'string' || !message.id.startsWith('cmd_') || !message.payload || typeof message.payload !== 'object') throw new TypeError('invalid command envelope');
    const p = message.payload;
    const versionedCall = typeof message.type === 'string' && message.type.startsWith('call.') && 'generation' in p;
    const cacheKey = versionedCall ? 'versioned:' + message.id : message.id;
    if (cache.has(cacheKey)) return [cache.get(cacheKey)];
    let error=null; const events=[];
    if (versionedCall) error='CAPABILITY_UNSUPPORTED';
    else if (message.type === 'sms.send') {
      if (typeof p.taskId !== 'string' || !Number.isInteger(p.slot) || typeof p.to !== 'string' || typeof p.body !== 'string' || !('subId' in p)) error='BAD_MESSAGE';
      else if (p.slot < 0 || p.slot >= simCount) error='SIM_NOT_READY';
      else events.push(emit('sms.result',{taskId:p.taskId,state:'sent',errorCode:null}));
    } else if (message.type === 'call.dial') {
      if (call) error='DEVICE_BUSY';
      else if (typeof p.callId !== 'string' || !p.media) error='CAPABILITY_UNSUPPORTED';
      else { try { startMedia(p.media); call={id:p.callId,state:'dialing'}; events.push(state(call.id,'dialing')); } catch { error='CAPABILITY_UNSUPPORTED'; } }
    } else if (message.type === 'call.answer') {
      if (!call || call.id !== p.callId || call.state !== 'ringing') error='CALL_NOT_RINGING';
      else if (!p.media) error='CAPABILITY_UNSUPPORTED';
      else { try { startMedia(p.media); call.state='connecting'; } catch { error='CAPABILITY_UNSUPPORTED'; } }
    } else if (message.type === 'call.reject' || message.type === 'call.hangup') {
      if (!call || call.id !== p.callId || (message.type === 'call.reject' && call.state !== 'ringing')) error=message.type === 'call.reject' ? 'CALL_NOT_RINGING' : 'CALL_NOT_FOUND';
      else { events.push(state(call.id,'disconnected',message.type === 'call.reject' ? 'rejected' : 'local_hangup')); call=null; }
    } else if (message.type === 'config.update') { /* transport owns heartbeat scheduling */ }
    else error='CAPABILITY_UNSUPPORTED';
    const ack=emit('ack',{refId:message.id,ok:error===null,error});
    cache.set(cacheKey,ack); if (cache.size > 500) cache.delete(cache.keys().next().value);
    return [ack,...events];
  }
  function incoming(callId, from = null) {
    if (call) throw new Error('device busy');
    call={id:callId,state:'ringing'};
    return emit('call.incoming',{callId,subId:1,slot:0,from,fromKind:from ? (from.startsWith('+') ? 'e164' : 'short') : 'unknown'});
  }
  const sms = (from,body) => emit('sms.received',{subId:1,slot:0,from,fromKind:from.startsWith('+') ? 'e164' : 'short',body,receivedAt:now(),parts:1});
  return {hello,heartbeat,snapshot:()=>{ const ts=now(); return envelope('status.snapshot',snapshot(simCount,ts),ts); },command,incoming,sms};
}
