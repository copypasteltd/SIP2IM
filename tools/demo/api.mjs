import { randomBytes } from 'node:crypto';
import { activeDevices, bindingId, bindingRecordId, dashboard, fixtureId, locales, platforms, publicDevice, seedDemo, syntheticNumber, threads } from './fixtures.mjs';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 41730;
export const MAX_BODY = 32_768;
const SESSION_MS = 8 * 60 * 60 * 1000;
const WRITE_WINDOW = 60_000;
const WRITE_LIMIT = 120;
const BINDING_LIMIT = 32;
const SMS_LIMIT = 48;
const authPrefix = 'Bearer ';
const bindingPath = '/api/devices/binding-codes';
const methodsWithWrites = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export class RequestError extends Error {
  constructor(status, code, details = null) {
    super(code);
    Object.assign(this, { status, code, details });
  }
}
const fail = (status, code, details) => { throw new RequestError(status, code, details); };
const bad = () => fail(400, 'BAD_REQUEST');
const missing = () => fail(404, 'NOT_FOUND');
export const fault = cause => ({ error: { code: cause.code, message: cause.code, details: cause.details } });
const data = value => ({ data: value });
const ok = () => data({});
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const text = (value, min, max) => typeof value === 'string' && value.length >= min && value.length <= max && !value.includes('\0');
const positive = value => Number.isSafeInteger(value) && value > 0;
const numbered = (value, max) => /^[0-9]+$/.test(value ?? '') && Number.isSafeInteger(Number(value)) && Number(value) <= max;
const matchIf = (filter, value) => filter === null || filter === value;
const includes = (query, ...fields) => !query || fields.some(field => field?.toLowerCase().includes(query.toLowerCase()));
const settingRule = {
  inboundRingTimeoutSec: positive,
  outboundUserAnswerTimeoutSec: positive,
  outboundCalleeAnswerTimeoutSec: positive,
  outboundCallbackRingTimeoutSec: positive,
  alertPushIntervalSec: positive,
  earlyMediaThresholdDbfs: Number.isFinite,
  smsForward: value => typeof value === 'boolean',
  smsRatePerMin: value => value === null || positive(value),
  heartbeatSec: value => positive(value) && value <= 86400,
  offlineAfterSec: positive,
  botLocale: value => locales.includes(value),
  inboundPlatform: value => platforms.includes(value),
  defaultDeviceId: value => value === null || (typeof value === 'string' && /^dev_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(value)),
};

function page(items, query, max = 200, defaultLimit = 50) {
  const limit = query.get('limit') ?? String(defaultLimit);
  if (!numbered(limit, max) || Number(limit) < 1) bad();
  const cursor = query.get('cursor');
  if (cursor !== null && !/^d[1-9][0-9]{0,3}$/.test(cursor)) bad();
  const start = cursor === null ? 0 : Number(cursor.slice(1));
  const end = start + Number(limit);
  return { data: items.slice(start, end), nextCursor: end < items.length ? 'd' + end : null };
}

function queryKeys(query, allowed = []) {
  const seen = new Set();
  for (const [key, value] of query) {
    if (seen.has(key) || !allowed.includes(key) || !text(value, 0, 512)) bad();
    seen.add(key);
  }
  return query;
}

function parseIdempotency(headers) {
  const key = headers['idempotency-key'];
  if (typeof key !== 'string' || !key.trim()) fail(400, 'IDEMPOTENCY_KEY_REQUIRED');
  if (!text(key, 1, 256)) bad();
  return key;
}

export function makeDemoApi({ now = Date.now, port = DEFAULT_PORT, onEvent = () => {} } = {}) {
  const state = seedDemo(now());
  const sessions = new Map();
  const sent = new Map();
  let bindingOrdinal = state.bindings.length;
  let writes = [];
  let locale = 'zh-CN';

  function authenticate(token) {
    if (typeof token !== 'string' || !/^voip-demo-[A-Za-z0-9_-]{32}$/.test(token)) return false;
    const expiry = sessions.get(token);
    if (expiry === undefined) return false;
    if (expiry > now()) return true;
    sessions.delete(token);
    return false;
  }

  function login(body) {
    if (!exact(body, ['username', 'password']) || typeof body.username !== 'string' || typeof body.password !== 'string') bad();
    if (body.username !== 'demo' || body.password !== 'demo') fail(401, 'UNAUTHORIZED');
    for (const token of sessions.keys()) authenticate(token);
    if (sessions.size >= 16) fail(429, 'DEMO_SESSION_LIMIT');
    const expiresAt = now() + SESSION_MS;
    const token = 'voip-demo-' + randomBytes(24).toString('base64url');
    sessions.set(token, expiresAt);
    return data({ token, expiresAt, admin: { username: 'demo', locale } });
  }

  function note(type, payload) {
    onEvent({ type, data: payload });
  }

  function historyDevice(device) {
    return { id: device.id, name: device.name, revoked: device.revoked };
  }

  function deactivate(device) {
    device.online = false;
    device.enabled = false;
    device.revoked = true;
    if (state.settings.defaultDeviceId === device.id) {
      state.settings.defaultDeviceId = null;
      note('settings.updated', {});
    }
    note('device.updated', { id: device.id });
  }

  function issueBinding(v2) {
    if (state.bindings.length >= BINDING_LIMIT) fail(429, 'DEMO_WRITE_LIMIT');
    const recordId = bindingRecordId(++bindingOrdinal);
    const code = String(680000 + bindingOrdinal);
    const createdAt = now();
    const expiresAt = createdAt + 300_000;
    const qrPayload = 'voipgw://bind?' + new URLSearchParams({ host: HOST, port: String(port), code });
    state.bindings.push({ recordId, createdAt, expiresAt, usedAt: null, deviceId: null, cancelledAt: null, protocolVersion: null, teardownPending: false });
    return data({ ...(v2 ? { recordId } : {}), code, expiresAt, qrPayload });
  }

  async function bindingRoute(method, path, query, body) {
    if (path === bindingPath && method === 'GET') {
      queryKeys(query, ['cursor']);
      const cursor = query.get('cursor');
      if (cursor !== null && !bindingId.test(cursor)) bad();
      return { data: state.bindings.filter(row => cursor === null || row.recordId > cursor), nextCursor: null };
    }
    if (method !== 'POST') return missing();
    queryKeys(query);
    if (!exact((await body()) ?? {}, [])) bad();
    if (path === bindingPath || path === bindingPath + '/v2') return issueBinding(path.endsWith('/v2'));
    const id = /^\/api\/devices\/binding-codes\/([^/]+)\/cancel$/.exec(path)?.[1];
    if (!id) return missing();
    if (!bindingId.test(id)) bad();
    const row = state.bindings.find(item => item.recordId === id);
    if (!row) return missing();
    if (row.cancelledAt === null) {
      row.cancelledAt = now();
      const device = activeDevices(state).find(item => item.id === row.deviceId);
      if (device) deactivate(device);
    }
    return data({ recordId: row.recordId, deviceId: row.deviceId });
  }

  async function deviceRoute(method, path, query, body) {
    if (path === '/api/devices' && method === 'GET') {
      queryKeys(query, ['q', 'online', 'limit', 'cursor']);
      const filter = query.get('q');
      const online = query.get('online');
      if ((filter?.length ?? 0) > 200 || (online !== null && !['true', 'false'].includes(online))) bad();
      const items = activeDevices(state).filter(device => matchIf(online, String(device.online)) && includes(filter, device.id, device.name, device.model));
      return page(items.map(publicDevice), query);
    }
    const match = /^\/api\/devices\/([^/]+)(?:\/(name|probe))?$/.exec(path);
    if (!match) return missing();
    const [, id, action] = match;
    const device = activeDevices(state).find(item => item.id === id);
    if (!device) return missing();
    if (method === 'GET' && action === undefined) {
      return data({ ...publicDevice(device), probes: device.probes, recentEvents: device.recentEvents, usbAutostart: null });
    }
    if (method === 'POST' && action === 'probe') {
      if (!device.online) fail(409, 'DEVICE_OFFLINE');
      if (!device.enabled || device.paused) fail(409, 'DEVICE_DISABLED');
      device.probes.sms = { result: 'ok', probedAt: now(), detail: 'Synthetic probe · 合成探测' };
      note('device.updated', { id });
      return ok();
    }
    if (method === 'DELETE' && action === undefined) {
      deactivate(device);
      return ok();
    }
    if (method !== 'PATCH') return missing();
    const input = await body();
    if (action === 'name') {
      if (!exact(input, ['name', 'expectedName']) || !text(input.name, 1, 200) || !input.name.trim() || !text(input.expectedName, 0, 200)) bad();
      if (device.revoked) return missing();
      if (input.expectedName !== device.name) fail(409, 'CONFLICT');
      device.name = input.name;
      note('device.updated', { id });
      return data({ id, name: device.name });
    }
    if (action !== undefined) return missing();
    if (!object(input)) bad();
    const keys = Object.keys(input);
    if (!keys.length || !keys.every(key => key === 'enabled' || key === 'callEnabled') || !keys.every(key => typeof input[key] === 'boolean')) bad();
    if (device.revoked) return missing();
    if (input.callEnabled === true) fail(409, 'CALL_NOT_ENABLED');
    if (Object.hasOwn(input, 'enabled')) device.enabled = input.enabled;
    note('device.updated', { id });
    return data(publicDevice(device));
  }

  async function simRoute(method, path, body) {
    const match = /^\/api\/sims\/([^/]+)\/(review|number\/conditional)$/.exec(path);
    if (!match) return missing();
    const [, id, action] = match;
    const device = activeDevices(state).find(item => item.sims.some(sim => sim.id === id));
    if (!device) fail(404, 'SIM_NOT_FOUND');
    const sim = device.sims.find(item => item.id === id);
    if (method === 'POST' && action === 'review') sim.needsReview = false;
    else if (method === 'PUT' && action === 'number/conditional') {
      const input = await body();
      if (!exact(input, ['number', 'expectedNumber']) || !text(input.number, 1, 64) ||
          (input.expectedNumber !== null && !text(input.expectedNumber, 0, 64))) bad();
      const number = syntheticNumber(input.number);
      if (!number) fail(400, 'NUMBER_INVALID');
      if (device.revoked) fail(404, 'SIM_NOT_FOUND');
      if (sim.number !== input.expectedNumber) fail(409, 'CONFLICT', { number: sim.number });
      sim.number = number;
      sim.numberSource = 'manual';
    } else return missing();
    note('device.updated', { id: device.id });
    return data({ ...sim, deviceId: device.id });
  }

  async function sendSms(headers, body) {
    const key = parseIdempotency(headers);
    const input = await body();
    if (!exact(input, ['simId', 'to', 'body']) || !text(input.simId, 1, 40) || !text(input.to, 1, 64) || !text(input.body, 1, 10_000)) bad();
    const peer = syntheticNumber(input.to);
    if (!peer) fail(400, 'NUMBER_INVALID');
    const old = sent.get(key);
    if (old) {
      if (old.simId !== input.simId || old.peer !== peer || old.body !== input.body) fail(409, 'IDEMPOTENCY_CONFLICT');
      return data(old);
    }
    const device = activeDevices(state).find(d => d.sims.some(sim => sim.id === input.simId));
    if (!device) fail(404, 'SIM_NOT_FOUND');
    if (!device.online) fail(409, 'DEVICE_OFFLINE');
    if (!device.enabled || device.paused) fail(409, 'DEVICE_DISABLED');
    const sim = device.sims.find(item => item.id === input.simId);
    if (sim.state !== 'ready' || now() - sim.lastSeenAt > 7_200_000) fail(409, 'SIM_NOT_READY');
    if (sent.size >= SMS_LIMIT) fail(429, 'DEMO_WRITE_LIMIT');
    const ordinal = 100 + sent.size;
    const occurredAt = now();
    const row = {
      id: fixtureId('sms', ordinal), deviceId: device.id, simId: input.simId, direction: 'out',
      peer, peerKind: 'e164', body: input.body, parts: Math.max(1, Math.ceil(input.body.length / 160)), occurredAt,
      task: { id: fixtureId('tsk', ordinal), state: 'sent', origin: 'web', errorCode: null, updatedAt: occurredAt },
    };
    sent.set(key, row);
    state.messages.unshift(row);
    note('sms.new', { id: row.id });
    return data(row);
  }

  function smsRead(path, query, headers) {
    if (path === '/api/sms/idempotency') {
      queryKeys(query);
      return data(sent.get(parseIdempotency(headers)) ?? null);
    }
    if (path === '/api/sms/history/devices') {
      queryKeys(query, ['q', 'limit', 'cursor']);
      return page(state.devices.filter(device => includes(query.get('q'), device.id, device.name)).map(historyDevice), query);
    }
    if (path === '/api/sms/history/sims') {
      queryKeys(query, ['deviceId', 'q', 'limit', 'cursor']);
      const sims = state.devices.filter(device => matchIf(query.get('deviceId'), device.id)).flatMap(device => device.sims.map(sim => ({
        id: sim.id, deviceId: device.id, slot: sim.slot, carrier: sim.carrier, number: sim.number,
        retired: device.revoked, deviceRevoked: device.revoked,
      })));
      return page(sims.filter(sim => includes(query.get('q'), sim.id, sim.carrier, sim.number)), query);
    }
    const deviceId = query.get('deviceId');
    const rows = state.messages.filter(row => matchIf(deviceId, row.deviceId));
    if (path === '/api/sms/threads') {
      queryKeys(query, ['deviceId', 'limit', 'cursor']);
      return page(threads(rows), query);
    }
    if (path !== '/api/sms') return missing();
    queryKeys(query, ['deviceId', 'simId', 'peer', 'from', 'to', 'toExclusive', 'limit', 'cursor']);
    const from = query.get('from');
    const to = query.get('to');
    const until = query.get('toExclusive');
    if ([from, to, until].some(value => value !== null && !numbered(value, 8_640_000_000_000_000))) bad();
    return page(rows.filter(row => matchIf(query.get('simId'), row.simId ?? 'null') && matchIf(query.get('peer'), row.peer) &&
      (from === null || row.occurredAt >= Number(from)) && (to === null || row.occurredAt <= Number(to)) &&
      (until === null || row.occurredAt < Number(until))), query);
  }

  function calls(method, path, query) {
    if (method === 'POST' && path === '/api/calls') fail(409, 'CALL_NOT_ENABLED');
    if (method === 'POST' && /^\/api\/calls\/[^/]+\/(hangup|dtmf)$/.test(path)) fail(409, 'CALL_NOT_ACTIVE');
    if (method !== 'GET') return missing();
    if (path === '/api/calls/availability') {
      queryKeys(query);
      return data({ deviceIds: [] });
    }
    if (path === '/api/calls') {
      queryKeys(query, ['kind', 'deviceId', 'active', 'limit', 'cursor']);
      const active = query.get('active');
      const kind = query.get('kind');
      if ((active !== null && !['true', 'false'].includes(active)) || (kind !== null && !['web_out', 'platform_in', 'platform_out'].includes(kind))) bad();
      const rows = active === 'true' ? [] : state.calls.filter(call => matchIf(kind, call.kind) && matchIf(query.get('deviceId'), call.deviceId));
      return page(rows.map(({ events, ...call }) => call), query);
    }
    const match = /^\/api\/calls\/(ses_[0-7][0-9A-HJKMNP-TV-Z]{25})(?:\/(summary|events))?$/.exec(path);
    if (!match) return missing();
    const call = state.calls.find(item => item.id === match[1]);
    if (!call) return missing();
    if (match[2] === 'events') return page(call.events, queryKeys(query, ['cursor', 'limit']), 100);
    queryKeys(query);
    const { events, ...summary } = call;
    return data(summary);
  }

  async function writeSettings(body) {
    const patch = await body();
    if (!exact(patch, ['changes', 'expected']) || !object(patch.changes) || !object(patch.expected)) bad();
    const keys = Object.keys(patch.changes);
    if (!keys.length || !exact(patch.expected, keys) || keys.some(key => !Object.hasOwn(settingRule, key) ||
      !settingRule[key](patch.changes[key]) || !settingRule[key](patch.expected[key]))) bad();
    if (keys.some(key => !Object.is(patch.expected[key], state.settings[key]))) fail(409, 'SETTINGS_CONFLICT');
    const next = { ...state.settings, ...patch.changes };
    if (next.offlineAfterSec <= next.heartbeatSec || (next.defaultDeviceId !== null &&
      !activeDevices(state).some(device => device.id === next.defaultDeviceId))) bad();
    const inboundChanged = next.inboundPlatform !== state.settings.inboundPlatform;
    state.settings = next;
    if (inboundChanged) note('channel.updated', { platform: next.inboundPlatform });
    note('settings.updated', {});
    return data(state.settings);
  }

  async function channels(method, path, body) {
    if (method === 'GET' && path === '/api/channels') {
      return data(state.channels.map(channel => ({ ...channel, isInbound: channel.platform === state.settings.inboundPlatform })));
    }
    if (method === 'PUT' && path === '/api/channels/inbound') {
      const input = await body();
      if (!exact(input, ['platform']) || !platforms.includes(input.platform)) bad();
      state.settings.inboundPlatform = input.platform;
      note('channel.updated', { platform: input.platform });
      note('settings.updated', {});
      return data({ platform: input.platform });
    }
    if (/^\/api\/channels\/(qq|telegram)\/(login(?:\/submit)?|logout|paired-user)$/.test(path)) fail(403, 'DEMO_DISABLED');
    return missing();
  }

  function records(method, path, query) {
    if (method === 'GET' && path === '/api/commands') {
      queryKeys(query, ['limit', 'cursor', 'platform', 'kind']);
      return page(state.commands.filter(row => matchIf(query.get('platform'), row.platform) && matchIf(query.get('kind'), row.kind)), query);
    }
    if (method === 'GET' && path === '/api/audit-logs') return page(state.audit, queryKeys(query, ['limit', 'cursor']));
    if (method === 'GET' && path === '/api/alerts') {
      queryKeys(query, ['state']);
      const filter = query.get('state');
      if (filter !== null && !['open', 'acked', 'resolved'].includes(filter)) bad();
      return data(state.alerts.filter(alert => matchIf(filter, alert.state)));
    }
    if (method === 'POST') {
      const id = /^\/api\/alerts\/([^/]+)\/ack$/.exec(path)?.[1];
      const alert = state.alerts.find(item => item.id === id);
      if (alert) {
        alert.state = 'acked';
        note('alert.resolved', { id });
        return ok();
      }
    }
    return missing();
  }

  async function handle({ method, url, headers, body }) {
    const path = url.pathname;
    const query = url.searchParams;
    if (method === 'GET' && path === '/api/health') {
      return data({ ok: true, db: 'disabled', adapters: { qq: 'offline', telegram: 'offline' }, synthetic: true });
    }
    if (path === '/api/device/bind' || path === '/api/device/bind-v2') fail(403, 'DEMO_DISABLED');
    const auth = headers.authorization;
    const token = typeof auth === 'string' && auth.startsWith(authPrefix) ? auth.slice(authPrefix.length) : '';
    const loggingIn = method === 'POST' && path === '/api/auth/login';
    if (!loggingIn && !authenticate(token)) fail(401, 'UNAUTHORIZED');
    if (methodsWithWrites.has(method)) {
      const at = now();
      writes = writes.filter(time => at - time < WRITE_WINDOW);
      if (writes.length >= WRITE_LIMIT) fail(429, 'DEMO_WRITE_LIMIT');
      writes.push(at);
    }
    if (loggingIn) return login(await body());
    // A request body can finish after a different tab has signed out.
    const readAuthorized = async () => {
      const input = await body();
      if (!authenticate(token)) fail(401, 'UNAUTHORIZED');
      return input;
    };
    if (method === 'POST' && path === '/api/auth/logout') {
      sessions.delete(token);
      return ok();
    }
    if (method === 'PUT' && path === '/api/auth/locale') {
      const input = await readAuthorized();
      if (!exact(input, ['locale']) || !locales.includes(input.locale)) bad();
      locale = input.locale;
      return data({ locale });
    }
    if (path === '/api/auth/password') fail(403, 'DEMO_DISABLED');
    if (method === 'GET' && path === '/api/dashboard') return data(dashboard(state, now()));
    if (path === bindingPath || path.startsWith(bindingPath + '/')) return bindingRoute(method, path, query, readAuthorized);
    if (path === '/api/devices' || path.startsWith('/api/devices/')) return deviceRoute(method, path, query, readAuthorized);
    if (path.startsWith('/api/sims/')) return simRoute(method, path, readAuthorized);
    if (method === 'POST' && path === '/api/sms') return sendSms(headers, readAuthorized);
    if (method === 'GET' && (path === '/api/sms' || path.startsWith('/api/sms/'))) return smsRead(path, query, headers);
    if (path === '/api/calls' || path.startsWith('/api/calls/')) return calls(method, path, query);
    if (path === '/api/channels' || path.startsWith('/api/channels/')) return channels(method, path, readAuthorized);
    if (method === 'GET' && path === '/api/settings') return data(state.settings);
    if (method === 'PUT' && path === '/api/settings/conditional') return writeSettings(readAuthorized);
    if (method === 'GET' && path === '/api/admin/sms-quarantine') {
      queryKeys(query, ['limit', 'cursor']);
      return page([], query, 25, 25);
    }
    return records(method, path, query);
  }

  return { authenticate, handle };
}
