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
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const isTimestamp = value => Number.isInteger(value) && value >= 0 && value <= 8_640_000_000_000_000;
const commandId = /^cmd_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const deviceIdPattern = /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// Do not let Node coerce an out-of-range interval to 1 ms.
const maxHeartbeatSec = Math.floor(2_147_483_647 / 1_000);

function isV1Command(message) {
  return message?.v === 1 && typeof message.id === 'string' && commandId.test(message.id) && isTimestamp(message.ts);
}

function configValues(value, complete = false) {
  if (!isObject(value) || Object.keys(value).some(key => key !== 'heartbeatSec' && key !== 'locale')) return null;
  const patch = {};
  if (complete || Object.hasOwn(value, 'heartbeatSec')) {
    const { heartbeatSec } = value;
    if (!Number.isInteger(heartbeatSec) || heartbeatSec < 1 || heartbeatSec > maxHeartbeatSec) return null;
    patch.heartbeatSec = heartbeatSec;
  }
  if (complete || Object.hasOwn(value, 'locale')) {
    if (typeof value.locale !== 'string') return null;
    patch.locale = value.locale;
  }
  // The wire accepts an empty patch, but there is nothing for this simulator to apply.
  return Object.keys(patch).length ? patch : null;
}

export function helloConfig(message, boundDeviceId) {
  const p = message?.payload;
  if (!isV1Command(message) || message.type !== 'hello.ok' || !isObject(p) ||
      typeof p.deviceId !== 'string' || !deviceIdPattern.test(p.deviceId) ||
      (boundDeviceId !== undefined && p.deviceId !== boundDeviceId) || !isTimestamp(p.serverTime)) return null;
  return configValues(p.config, true);
}

export function createDevice({ token, simCount = 1, now = Date.now }) {
  if (typeof token !== 'string' || !token) throw new TypeError('token is required');
  const cache = new Map(); let call = null;
  const emit = (type,payload) => envelope(type,payload,now());
  const hello = () => emit('hello',{token,apkVersion:'0.1.0',apkCode:1,protocol:1,manufacturer:'Simulator',model:'Virtual',apiLevel:34,locale:'en'});
  const heartbeat = () => emit('heartbeat',{battery:100,charging:true,network:'wifi',signalDbm:null,shizuku:'unknown',paused:false});
  const state = (callId,state,cause=null) => emit('call.state',{callId,state,cause});
  function configCommand(message, config) {
    if (!isV1Command(message)) throw new TypeError('invalid config command envelope');
    const receipt = error => emit('ack', { refId: message.id, ok: error === null, error });
    const patch = configValues(message.payload);
    if (!patch) return [receipt('BAD_MESSAGE')];
    if (!config) return [receipt('CAPABILITY_UNSUPPORTED')];
    const signature = JSON.stringify(patch);
    const previous = config.receipts.get(message.id);
    if (previous) return [previous.signature === signature ? previous.ack : receipt('CONFLICT')];

    const ack = receipt(config.apply(patch) === true ? null : 'INTERNAL');
    config.receipts.set(message.id, { signature, ack });
    if (config.receipts.size > 500) config.receipts.delete(config.receipts.keys().next().value);
    return [ack];
  }

  function command(message, startMedia = () => {}, config) {
    if (message?.type === 'config.update') return configCommand(message, config);
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
    } else error='CAPABILITY_UNSUPPORTED';
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
