import WebSocket from 'ws';
import { ulid } from 'ulid';

// This executable intentionally starts no service and never prints server data.
const fail = message => { throw new Error(message); };
const origin = process.env.CORE_STAGING_ORIGIN ?? '';
const adminToken = process.env.CORE_STAGING_ADMIN_TOKEN ?? '';
if (process.env.CORE_STAGING_OPT_IN !== 'yes') fail('Set CORE_STAGING_OPT_IN=yes to enable this state-changing staging harness');
if (!/^http:\/\/(?:127\.0\.0\.1|\[::1\]):[0-9]{1,5}$/.test(origin)) fail('Origin must be a literal loopback HTTP origin with port');
const port = Number(origin.slice(origin.lastIndexOf(':') + 1));
if (port < 1 || port > 65535 || !adminToken || /[\r\n]/.test(adminToken)) fail('Invalid staging configuration');
const meta = {manufacturer:'VOIPGW synthetic',model:'staging-harness-'+ulid(),apiLevel:30,apkVersion:'synthetic',apkCode:1,locale:'en'};
const request = async (path, method, body, authenticated = false) => {
  const response = await fetch(origin + path, {method, redirect:'error', signal:AbortSignal.timeout(10000), headers:{...(body ? {'content-type':'application/json'} : {}), ...(authenticated ? {authorization:'Bearer '+adminToken} : {})}, ...(body ? {body:JSON.stringify(body)} : {})});
  if (!response.ok) fail('HTTP operation failed (' + response.status + ')');
  return response.json();
};
const envelope = (type,payload) => ({v:1,type,id:'evt_'+ulid(),ts:Date.now(),payload});
let socket;
let deviceId;
let bindStarted = false;
let passed = false;
let cleanupFailed = false;
try {
  const codeResult = await request('/api/devices/binding-codes','POST',{},true);
  const code = codeResult?.data?.code;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) fail('Invalid binding-code response');
  bindStarted = true; // Never retry: a lost response can still have consumed the code.
  const bound = await request('/api/device/bind','POST',{code,...meta});
  const candidateId = bound?.data?.deviceId;
  if (typeof candidateId !== 'string' || !/^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(candidateId)) fail('Invalid binding response');
  deviceId = candidateId;
  const token = bound?.data?.token;
  if (typeof token !== 'string' || !token) fail('Invalid binding response');
  socket = new WebSocket(origin.replace(/^http:/,'ws:') + '/ws/device', {handshakeTimeout:10000, maxPayload:65536, followRedirects:false});
  await new Promise((resolve,reject) => {
    let stage = 'open';
    const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 15000);
    const done = (error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    socket.once('error', () => done(new Error('WebSocket error')));
    socket.once('close', () => done(new Error('WebSocket closed before completion')));
    socket.once('open', () => { stage='hello'; socket.send(JSON.stringify(envelope('hello',{token,...meta,protocol:1}))); });
    let snapshotId;
    socket.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (stage === 'hello' && msg?.v === 1 && msg.type === 'hello.ok' && msg.payload?.deviceId === deviceId && Number.isInteger(msg.payload?.config?.heartbeatSec) && msg.payload.config.heartbeatSec > 0 && typeof msg.payload.config.locale === 'string') {
          socket.send(JSON.stringify(envelope('heartbeat',{battery:null,charging:null,network:'unknown',signalDbm:null,shizuku:'unknown',paused:true})));
          const probe = {result:'untested',probedAt:Date.now(),detail:null};
          const probes = Object.fromEntries(['smsSend','smsReceive','dial','answer','hangup','dtmf','downlink','uplink','earlyMedia'].map(k => [k,probe]));
          const snapshot = envelope('status.snapshot',{sims:[],simsAuthoritative:false,capabilityLevel:'L1',probes,permissions:[]});
          snapshotId = snapshot.id; stage = 'ack'; socket.send(JSON.stringify(snapshot));
        } else if (stage === 'ack' && msg?.v === 1 && msg.type === 'ack' && msg.payload?.refId === snapshotId && msg.payload.ok === true && msg.payload.error === null) { stage='done'; done(); }
        else { done(new Error('Unexpected WebSocket frame')); }
      } catch { done(new Error('Invalid WebSocket frame')); }
    });
  });
  const listed = await request('/api/devices?limit=10&q='+encodeURIComponent(meta.model),'GET',undefined,true);
  const entries = Array.isArray(listed?.data) ? listed.data.filter(item => item.id === deviceId) : [];
  const device = entries[0];
  if (entries.length !== 1 || listed.nextCursor !== null || device.model !== meta.model || device.manufacturer !== meta.manufacturer || device.online !== true || device.paused !== true || device.capabilityLevel !== 'L1' || device.status?.network?.value !== 'unknown') fail('Synthetic identity or persisted status mismatch');
  passed = true;
} catch {
  console.error('Staging harness failed; response details suppressed.');
  if (bindStarted && !deviceId) console.error('Binding outcome may be uncertain; inspect staging for the synthetic device before retrying.');
} finally {
  if (socket) {
    try {
      socket.removeAllListeners(); socket.on('error',()=>{});
      const closed = await new Promise(resolve => {
        if (socket.readyState === WebSocket.CLOSED) return resolve(true);
        const timer = setTimeout(() => resolve(false), 3000);
        socket.once('close', () => { clearTimeout(timer); resolve(true); });
        try { socket.terminate(); } catch { clearTimeout(timer); resolve(false); }
      });
      if (!closed) { cleanupFailed=true; console.error('Socket closure unconfirmed.'); }
    } catch { cleanupFailed=true; console.error('Socket cleanup failed.'); }
  }
  if (deviceId) {
    try {
      await request('/api/devices/'+encodeURIComponent(deviceId),'DELETE',undefined,true);
      const check = await fetch(origin+'/api/devices/'+encodeURIComponent(deviceId), {headers:{authorization:'Bearer '+adminToken},redirect:'error',signal:AbortSignal.timeout(10000)});
      if (check.status !== 404) fail('Revocation verification failed');
    } catch { cleanupFailed=true; console.error('Synthetic device revocation or verification failed; inspect staging manually. Do not retry blindly.'); }
  }
}
if (passed && !cleanupFailed) console.log('PASS: bound synthetic device; hello, heartbeat submission, status persistence ACK; socket closed and device revoked. Heartbeat is not independently acknowledged.');
else process.exitCode=1;
