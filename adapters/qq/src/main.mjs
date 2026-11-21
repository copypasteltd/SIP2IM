import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const MAX_TIMESTAMP = 8_640_000_000_000_000;
// Keep this standalone executable aligned with packages/protocol/src/errors.ts.
const ACK_ERRORS = new Set([
  'BAD_REQUEST', 'BAD_MESSAGE', 'IDEMPOTENCY_KEY_REQUIRED', 'UNAUTHORIZED', 'LOGIN_LOCKED',
  'NOT_FOUND', 'CONFLICT', 'EVENT_TOO_LARGE', 'BINDING_INVALID', 'BINDING_EXPIRED', 'BINDING_RATE_LIMITED',
  'DEVICE_OFFLINE', 'DEVICE_BUSY', 'DEVICE_DISABLED', 'CALL_NOT_ENABLED', 'CAPABILITY_UNSUPPORTED',
  'SMS_PERMISSION_MISSING', 'CALL_PERMISSION_MISSING', 'SIM_NOT_FOUND', 'SIM_AMBIGUOUS',
  'SIM_NOT_READY', 'NO_DEFAULT_DEVICE', 'NUMBER_INVALID', 'NUMBER_EMERGENCY', 'NUMBER_REGION',
  'CHANNEL_UNAVAILABLE', 'CHANNEL_BUSY', 'NOT_PAIRED', 'PAIRING_INVALID', 'PAIRING_LOCKED',
  'CALL_NOT_RINGING', 'CALL_NOT_ACTIVE', 'CALL_NOT_FOUND', 'TIMEOUT_UNKNOWN', 'INTERNAL',
]);
function id() {
  let n = (BigInt(Date.now()) << 80n) | BigInt('0x' + randomBytes(10).toString('hex'));
  let value = ''; for (let i = 0; i < 26; i++) { value = alphabet[Number(n & 31n)] + value; n >>= 5n; }
  return 'ipc_' + value;
}
export function envelope(type, payload) { return { v: 1, type, id: id(), ts: Date.now(), payload }; }
const validId = value => typeof value === 'string' && /^ipc_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
const validCall = value => typeof value === 'string' && /^cal_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value);
function valid(m) {
  if (!m || m.v !== 1 || !validId(m.id) || !Number.isInteger(m.ts) || m.ts < 0 || m.ts > MAX_TIMESTAMP || typeof m.payload !== 'object' || !m.payload || Array.isArray(m.payload)) return false;
  const p = m.payload;
  switch (m.type) {
    // The shared ACK schema accepts an opaque string; only an exact pending ID selects an operation.
    case 'ack': return typeof p.refId === 'string' && (p.ok === true ? p.error === null : p.ok === false && ACK_ERRORS.has(p.error));
    case 'account.login': case 'account.logout': return true;
    case 'account.login.submit': return ['qr','phone','code','password'].includes(p.step) && typeof p.value === 'string';
    case 'message.send': return typeof p.userId === 'string' && typeof p.text === 'string';
    case 'call.hangup': return validCall(p.callId);
    case 'call.dial': return validCall(p.callId) && typeof p.userId === 'string' && Number.isInteger(p.audioChannel) && p.audioChannel >= 0 && p.audioChannel <= 255;
    default: return false;
  }
}
function encode(m) { const body = Buffer.from(JSON.stringify(m)); if (body.length + 1 > 1048576) throw Error('frame too large'); const b = Buffer.alloc(body.length + 5); b.writeUInt32BE(body.length + 1); b[4] = 1; body.copy(b, 5); return b; }
export class Client {
  constructor(path, handler = async () => [false, 'CAPABILITY_UNSUPPORTED'], timeout = 10000, now = () => performance.now()) {
    this.path = path; this.handler = handler; this.timeout = timeout; this.now = now; this.pending = new Map(); this.recent = new Map(); this.inflight = new Map(); this.stopped = false;
  }
  #takePending(id, entry) {
    if (this.pending.get(id) !== entry) return false;
    this.pending.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    return true;
  }
  #expire(id, entry) {
    if (this.#takePending(id, entry)) entry.reject(Error('ack timeout; outcome unknown'));
  }
  #disconnect(socket) {
    for (const [id, entry] of this.pending) {
      if (entry.socket === socket && this.#takePending(id, entry)) entry.reject(Error('disconnected; outcome unknown'));
    }
  }
  send(message, socket = this.socket) {
    return new Promise((resolve, reject) => {
      const isCurrent = () => !this.stopped && socket && socket === this.socket && !socket.destroyed;
      if (!isCurrent()) return reject(Error('disconnected'));
      const id = message.id;
      if (this.pending.has(id)) return reject(Error('report ID is already pending'));
      const bytes = encode(message), write = socket.write;
      if (!isCurrent()) return reject(Error('disconnected'));
      if (this.pending.has(id)) return reject(Error('report ID is already pending'));
      const entry = { resolve, reject, socket, deadline:this.now() + this.timeout, timer:undefined };
      this.pending.set(id, entry);
      try { Reflect.apply(write, socket, [bytes]); }
      catch {
        if (this.#takePending(id, entry)) reject(Error('send failed; outcome unknown'));
        return;
      }
      const check = () => {
        if (this.pending.get(id) !== entry) return;
        const remaining = entry.deadline - this.now();
        if (remaining <= 0) this.#expire(id, entry);
        else entry.timer = setTimeout(check, Math.ceil(remaining));
      };
      check();
    });
  }
  async receive(message, socket = this.socket) {
    if (this.stopped || !socket || socket.destroyed || socket !== this.socket) return;
    if (!valid(message)) {
      if (message?.type !== 'ack' && validId(message?.id)) socket.write(encode(envelope('ack', {refId: message.id, ok:false, error:'BAD_MESSAGE'})));
      else socket.destroy();
      return;
    }
    if (message.type === 'ack') {
      const id = message.payload.refId, entry = this.pending.get(id);
      if (!entry || entry.socket !== socket) return;
      if (this.now() >= entry.deadline) this.#expire(id, entry);
      else if (this.#takePending(id, entry)) entry.resolve(message.payload);
      return;
    }
    let result = this.recent.get(message.id);
    if (!result) {
      let pending = this.inflight.get(message.id);
      if (!pending) {
        pending = (async () => {
          let outcome; try { outcome = await this.handler(message.type, message.payload); } catch { outcome = [false, 'INTERNAL']; }
          const ack = envelope('ack', {refId: message.id, ok:outcome[0], error:outcome[1]});
          this.recent.set(message.id, ack);
          if (this.recent.size > 500) this.recent.delete(this.recent.keys().next().value);
          return ack;
        })();
        this.inflight.set(message.id, pending);
        pending.finally(() => this.inflight.delete(message.id));
      }
      result = await pending;
    }
    if (!this.stopped && socket === this.socket && !socket.destroyed) socket.write(encode(result));
  }
  connect() {
    return new Promise((resolve) => {
      const socket = net.createConnection(this.path); this.socket = socket;
      let buffer = Buffer.alloc(0); let queue = Promise.resolve(); let readyAt = null;
      socket.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
          const length = buffer.readUInt32BE();
          if (!length || length > 1048576) { socket.destroy(); return; }
          if (buffer.length < length + 4) return;
          const frame = buffer.subarray(4, length + 4); buffer = buffer.subarray(length + 4);
          if (frame[0] !== 1) { socket.destroy(); return; }
          let message; try { message = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(frame.subarray(1))); } catch { socket.destroy(); return; }
          if (message?.type === 'ack') void this.receive(message, socket);
          else queue = queue.then(() => this.receive(message, socket)).catch(() => socket.destroy());
        }
      });
      socket.on('connect', async () => {
        try {
          for (const msg of [envelope('adapter.hello', {platform:'qq',adapterVersion:'0.1.0',protocol:1}), envelope('capabilities', {login:false,sendMessage:false,receiveMessage:false,dial:false,receiveAudio:false,sendAudio:false,maxConcurrentCalls:0}), envelope('account.state', {state:'logged_out',selfId:null,alias:null,detail:'platform backend unavailable'})]) {
            if (!(await this.send(msg, socket)).ok) throw Error('startup rejected');
          }
          if (!socket.destroyed && socket === this.socket) readyAt = performance.now();
        } catch { socket.destroy(); }
      });
      socket.on('error', () => {});
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined;
        this.#disconnect(socket);
        resolve(readyAt !== null && performance.now() - readyAt >= 30000);
      });
    });
  }
  async run() { let delay = 1000; while (!this.stopped) { const stable = await this.connect(); if (this.stopped) break; if (stable) delay = 1000; await new Promise(resolve => { this.wake = resolve; this.timer = setTimeout(resolve, delay); }); delay = Math.min(delay * 2, 30000); } }
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.socket) { this.#disconnect(this.socket); this.socket.destroy(); }
    clearTimeout(this.timer);
    this.wake?.();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const client = new Client(process.argv[2] || '/run/voip-gateway/adapter-qq.sock');
  process.on('SIGINT', () => client.stop()); process.on('SIGTERM', () => client.stop());
  await client.run();
}
