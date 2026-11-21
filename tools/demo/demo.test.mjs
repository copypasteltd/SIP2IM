import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { DEFAULT_PORT, HOST, MAX_BODY, makeDemoApi } from './api.mjs';
import { bindingRecordId, fixtureId } from './fixtures.mjs';
import { wireAdminSocket } from './realtime.mjs';
import { makeDemoServer, parsePort } from './server.mjs';

const fixtureTime = Date.UTC(2026, 0, 15, 12);
const authority = HOST + ':' + DEFAULT_PORT;
const origin = 'http://' + authority;
const loginInput = { username: 'demo', password: 'demo' };
const codes = '/api/devices/binding-codes';
const readDistIndex = () => readFile(new URL('../../web/dist/index.html', import.meta.url), 'utf8');

// Dispatch the real HTTP request handler with local streams. No bind, connection, or browser.
async function harness(t, now = () => fixtureTime) {
  const { server, origin: servedOrigin, realtimeEnabled } = await makeDemoServer({ now });
  t.after(() => server.emit('close'));
  const handler = server.listeners('request')[0];
  const request = async (url, options = {}) => {
    const { method = 'GET', token, body, raw, extra = {}, remoteAddress = HOST } = options;
    const chunks = raw ?? (body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
    const req = Readable.from(chunks);
    Object.assign(req, { method, url, socket: { remoteAddress }, headers: {
      host: authority,
      ...(token ? { authorization: 'Bearer ' + token } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...extra,
    } });
    const response = { code: undefined, headers: {}, content: '' };
    const res = {
      setHeader: (key, value) => { response.headers[key.toLowerCase()] = value; },
      writeHead: (code, headers) => {
        response.code = code;
        for (const [key, value] of Object.entries(headers)) res.setHeader(key, value);
      },
      end: (content = '') => { response.content = content.toString(); },
    };
    await handler(req, res);
    return { ...response, json: () => JSON.parse(response.content) };
  };
  const signedIn = async () => {
    const result = await request('/api/auth/login', { method: 'POST', body: loginInput });
    assert.equal(result.code, 200);
    const session = result.json().data;
    assert.equal(session.admin.username, 'demo');
    assert.ok(session.expiresAt > now());
    return session.token;
  };
  return { request, signedIn, server, servedOrigin, realtimeEnabled };
}

const data = response => {
  assert.equal(response.code, 200, response.content);
  return response.json().data;
};
const error = (response, status, code) => {
  assert.equal(response.code, status, response.content);
  assert.equal(response.json().error.code, code);
};

test('serves original built React and CSS assets with a bilingual synthetic notice', async t => {
  const { server, servedOrigin, request } = await harness(t);
  assert.equal(servedOrigin, origin);
  assert.equal(server.listening, false);
  assert.equal(parsePort([]), 41730);
  assert.equal(parsePort(['--port', '41731']), 41731);
  assert.throws(() => parsePort(['--host', 'localhost']), /Usage/);
  assert.throws(() => parsePort(['--port', '0']), /port/);
  const index = await readDistIndex();
  const root = await request('/');
  assert.equal(root.code, 200);
  assert.match(root.content, /Synthetic demo \/ 合成演示/);
  assert.match(root.content, /demo \/ demo/);
  assert.ok(root.content.indexOf('voip-demo-banner') < root.content.indexOf('id="root"'));
  assert.match(root.headers['content-security-policy'], /connect-src 'self' ws:\/\/127\.0\.0\.1:41730/);
  assert.match(root.headers['permissions-policy'], /microphone=\(\)/);
  assert.equal((await request('/devices/' + fixtureId('dev', 1))).content, root.content);
  for (const [, tag, asset] of index.matchAll(/<(script|link)\b[^>]*(?:src|href)="(\/assets\/[^" ]+)"/g)) {
    const result = await request(asset);
    assert.equal(result.code, 200);
    assert.match(result.headers['content-type'], tag === 'script' ? /javascript/ : /css/);
    assert.ok(root.content.includes(asset));
    assert.ok(result.content.length > 0);
  }
  assert.equal((await request('/__voip-demo/banner.css', { method: 'HEAD' })).content, '');
  error(await request('/assets/missing.js'), 404, 'NOT_FOUND');
  assert.equal(await readDistIndex(), index);
});

test('locks transport to the exact local authority and bounds request bodies', async t => {
  const { request } = await harness(t);
  error(await request('/', { extra: { host: 'localhost:' + DEFAULT_PORT } }), 403, 'DEMO_LOCAL_ONLY');
  error(await request('/', { remoteAddress: '::1' }), 403, 'DEMO_LOCAL_ONLY');
  error(await request('/api/auth/login', { method: 'POST', body: loginInput, extra: { origin: 'http://127.0.0.1:41731' } }), 403, 'DEMO_LOCAL_ONLY');
  error(await request('/', { extra: { 'sec-fetch-site': 'cross-site' } }), 403, 'DEMO_LOCAL_ONLY');
  const login = raw => request('/api/auth/login', { method: 'POST', raw, extra: { 'content-type': 'application/json' } });
  error(await login([Buffer.from('{')]), 400, 'BAD_REQUEST');
  error(await login([Buffer.from([0x22, 0xff, 0x22])]), 400, 'BAD_REQUEST');
  error(await login([Buffer.alloc(MAX_BODY), Buffer.alloc(1)]), 413, 'BODY_TOO_LARGE');
  const huge = await request('/api/auth/login', { method: 'POST', extra: { 'content-length': String(MAX_BODY + 1) } });
  error(huge, 413, 'BODY_TOO_LARGE');
  assert.equal(huge.headers.connection, 'close');
});

test('exposes public health, guards admin data, and revokes demo sessions', async t => {
  const { request, signedIn } = await harness(t);
  const health = data(await request('/api/health'));
  assert.deepEqual(health.adapters, { qq: 'offline', telegram: 'offline' });
  assert.equal(health.synthetic, true);
  const bad = await request('/api/auth/login', { method: 'POST', body: { username: 'sample', password: 'sample' } });
  error(bad, 401, 'UNAUTHORIZED');
  error(await request('/api/dashboard'), 401, 'UNAUTHORIZED');
  error(await request(codes), 401, 'UNAUTHORIZED');
  error(await request(codes + '/v2', { method: 'POST' }), 401, 'UNAUTHORIZED');
  error(await request(codes + '/' + bindingRecordId(1) + '/cancel', { method: 'POST' }), 401, 'UNAUTHORIZED');
  const token = await signedIn();
  const get = path => request(path, { token });
  const dashboard = data(await get('/api/dashboard'));
  assert.deepEqual(dashboard.devices, { total: 3, online: 2, offline: 1, paused: 1, byLevel: { L1: 2, L2: 1, L3: 0, L4: 0, L5: 0 } });
  assert.deepEqual(dashboard.capability, { smsReady: 1, callReady: 0, inCall: 0 });
  assert.equal(dashboard.alerts.open, 1);
  assert.equal(data(await get('/api/devices?online=false&q=field')).length, 1);
  const firstPage = await get('/api/devices?limit=1');
  const nextCursor = firstPage.json().nextCursor;
  assert.ok(nextCursor);
  assert.notEqual(data(firstPage)[0].id, data(await get('/api/devices?limit=1&cursor=' + nextCursor))[0].id);
  assert.equal((await request('/api/auth/logout', { token, method: 'POST' })).code, 200);
  error(await get('/api/dashboard'), 401, 'UNAUTHORIZED');
});

test('issues and cancels v2 admin records without exposing codes in inventory', async t => {
  let time = fixtureTime;
  const { request, signedIn } = await harness(t, () => time);
  const token = await signedIn();
  const get = path => request(path, { token });
  const post = path => request(path, { method: 'POST', token });
  const legacy = data(await post(codes));
  assert.deepEqual(Object.keys(legacy).sort(), ['code', 'expiresAt', 'qrPayload']);
  const issued = data(await post(codes + '/v2'));
  assert.match(issued.code, /^[0-9]{6}$/);
  assert.equal(issued.expiresAt, time + 300_000);
  const qr = new URL(issued.qrPayload);
  assert.equal(qr.searchParams.get('host'), HOST);
  assert.equal(qr.searchParams.get('port'), String(DEFAULT_PORT));
  assert.equal(qr.searchParams.get('code'), issued.code);
  const fresh = data(await get(codes)).find(item => item.recordId === issued.recordId);
  assert.deepEqual(fresh, { recordId: issued.recordId, createdAt: time, expiresAt: issued.expiresAt,
    usedAt: null, deviceId: null, cancelledAt: null, protocolVersion: null, teardownPending: false });
  time++;
  const cancel = codes + '/' + issued.recordId + '/cancel';
  assert.deepEqual(data(await post(cancel)), { recordId: issued.recordId, deviceId: null });
  time++;
  assert.deepEqual(data(await post(cancel)), { recordId: issued.recordId, deviceId: null });
  assert.equal(data(await get(codes + '?cursor=' + bindingRecordId(1))).at(-1).cancelledAt, time - 1);
  assert.equal(data(await post(codes + '/' + bindingRecordId(1) + '/cancel')).deviceId, fixtureId('dev', 3));
  error(await get('/api/devices/' + fixtureId('dev', 3)), 404, 'NOT_FOUND');
  assert.equal(data(await get('/api/dashboard')).devices.total, 2);
  assert.ok(data(await get('/api/sms/history/devices')).find(row => row.id === fixtureId('dev', 3)).revoked);
  error(await post('/api/device/bind'), 403, 'DEMO_DISABLED');
  error(await post('/api/device/bind-v2'), 403, 'DEMO_DISABLED');
});

test('keeps SMS list, thread, null SIM, and local send replay coherent', async t => {
  const { request, signedIn } = await harness(t);
  const token = await signedIn();
  const get = path => request(path, { token });
  const first = data(await get('/api/sms/threads?limit=50'))[0];
  const params = new URLSearchParams({ deviceId: first.deviceId, simId: first.simId, peer: first.peer });
  assert.equal(data(await get('/api/sms?' + params)).length, 3);
  assert.equal(first.key, [first.deviceId, first.simId, first.peer].join(':'));
  assert.equal(data(await get('/api/sms?simId=null'))[0].simId, null);
  assert.equal(data(await get('/api/admin/sms-quarantine?limit=25')).length, 0);
  const submit = (to, key, body = 'Fixture reply · 演示回复') => request('/api/sms', {
    method: 'POST', token, extra: { 'idempotency-key': key }, body: { simId: first.simId, to, body },
  });
  const sent = data(await submit(first.peer, 'offline-example'));
  assert.equal(sent.direction, 'out');
  assert.equal(sent.task.state, 'sent');
  assert.deepEqual(data(await submit(first.peer, 'offline-example')), sent);
  error(await submit(first.peer, 'offline-example', 'other draft'), 409, 'IDEMPOTENCY_CONFLICT');
  error(await submit('+12025550199 extension', 'outside-demo'), 400, 'NUMBER_INVALID');
  assert.deepEqual(data(await request('/api/sms/idempotency', { token, extra: { 'idempotency-key': 'offline-example' } })), sent);
  assert.equal(data(await get('/api/sms?' + params)).length, 4);
  assert.equal(data(await get('/api/sms/threads'))[0].lastBody, sent.body);
});

test('keeps call controls disabled and the fixture settings conditional', async t => {
  const { request, signedIn } = await harness(t);
  const token = await signedIn();
  const get = path => request(path, { token });
  const put = (path, body) => request(path, { method: 'PUT', token, body });
  assert.deepEqual(data(await get('/api/calls/availability')), { deviceIds: [] });
  assert.deepEqual(data(await get('/api/calls?active=true&limit=50')), []);
  const call = data(await get('/api/calls'))[0];
  assert.equal(call.state, 'ended');
  assert.equal(data(await get('/api/calls/' + call.id + '/summary')).legs.length, 2);
  assert.equal(data(await get('/api/calls/' + call.id + '/events')).length, 3);
  error(await request('/api/calls', { token, method: 'POST', body: { simId: call.simId, to: call.peer } }), 409, 'CALL_NOT_ENABLED');
  error(await request('/api/calls/' + call.id + '/hangup', { token, method: 'POST' }), 409, 'CALL_NOT_ACTIVE');
  assert.ok(data(await get('/api/channels')).every(row => row.capabilities.login === false));
  data(await put('/api/channels/inbound', { platform: 'telegram' }));
  assert.equal(data(await get('/api/channels')).find(row => row.isInbound).platform, 'telegram');
  const endpoint = '/api/settings/conditional';
  const patch = { changes: { heartbeatSec: 35 }, expected: { heartbeatSec: 30 } };
  assert.equal(data(await put(endpoint, patch)).heartbeatSec, 35);
  error(await put(endpoint, patch), 409, 'SETTINGS_CONFLICT');
  error(await put(endpoint, { changes: { offlineAfterSec: 35 }, expected: { offlineAfterSec: 90 } }), 400, 'BAD_REQUEST');
  assert.equal(data(await get('/api/settings')).heartbeatSec, 35);
  assert.deepEqual(data(await put('/api/auth/locale', { locale: 'en' })), { locale: 'en' });
  error(await put('/api/auth/password', { oldPassword: 'demo', newPassword: 'fixture-change' }), 403, 'DEMO_DISABLED');
  error(await request('/api/channels/telegram/login/submit', { token, method: 'POST', body: { step: 'code', value: 'fixture-only' } }), 403, 'DEMO_DISABLED');
});

test('limits binding allocations and blocks writes completed after logout', async t => {
  const { request, signedIn } = await harness(t);
  const token = await signedIn();
  for (let i = 0; i < 30; i++) data(await request(codes + '/v2', { method: 'POST', token }));
  error(await request(codes + '/v2', { method: 'POST', token }), 429, 'DEMO_WRITE_LIMIT');
  assert.equal(data(await request(codes, { token })).length, 32);

  const api = makeDemoApi({ now: () => fixtureTime });
  const write = (path, headers, body) => api.handle({ method: 'POST', url: new URL(path, origin), headers, body });
  const session = (await write('/api/auth/login', {}, () => loginInput)).data;
  const headers = { authorization: 'Bearer ' + session.token };
  const deferred = Promise.withResolvers();
  const pending = write(codes + '/v2', headers, () => deferred.promise);
  await write('/api/auth/logout', headers, () => undefined);
  const checked = assert.rejects(pending, { status: 401, code: 'UNAUTHORIZED' });
  deferred.resolve(undefined);
  await checked;
});

test('admin WebSocket accepts the Web auth/ping frames and stops after revocation', () => {
  class LocalSocket extends EventEmitter {
    readyState = 1;
    bufferedAmount = 0;
    frames = [];
    send(payload) { this.frames.push(JSON.parse(payload)); }
    close(code) { this.closed = code; this.readyState = 3; this.emit('close'); }
    terminate() { this.close(1006); }
    receive(payload) { this.emit('message', Buffer.from(JSON.stringify(payload)), false); }
  }
  const token = 'synthetic-ws-fixture';
  let active = true;
  const authenticate = value => active && value === token;
  const noAuth = new LocalSocket();
  wireAdminSocket(noAuth, authenticate);
  noAuth.receive({ type: 'ping' });
  assert.equal(noAuth.closed, 4403);
  const socket = new LocalSocket();
  const publish = wireAdminSocket(socket, authenticate);
  const event = { type: 'settings.updated', data: {} };
  publish(JSON.stringify(event));
  assert.deepEqual(socket.frames, []);
  socket.receive({ type: 'auth', token });
  socket.receive({ type: 'ping' });
  publish(JSON.stringify(event));
  assert.deepEqual(socket.frames, [{ type: 'pong' }, event]);
  active = false;
  socket.receive({ type: 'ping' });
  assert.equal(socket.closed, 4403);
  assert.equal(socket.frames.length, 2);
});
