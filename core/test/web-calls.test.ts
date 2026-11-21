import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { encodeMediaFrame } from '@voipgw/protocol';
import { ulid } from 'ulid';
import { DeviceCommands, type CurrentCallAttachment } from '../src/ws-device/commands.js';
import { DeviceSessions } from '../src/ws-device/session.js';
import { WebCalls } from '../src/calls/web-calls.js';
import { CallRequestError, type WebCallIds, type WebCallRecord, type WebCallSituation } from '../src/calls/web-call-store.js';
import { MediaTransport } from '../src/media/transport.js';
import { registerWebCallRoutes } from '../src/http/web-calls.js';

const simId = 'sim_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const request = { key: 'first-call', simId, to: '12345', peerKind: 'short' as const };
const makeSocket = () => ({ bufferedAmount: 0, send: vi.fn(), close: vi.fn() });
const silence = (seq = 0) => encodeMediaFrame({ format: 2, flags: 4, seq, captureTs: 0, pcm: new Uint8Array() });
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

function fixture(allowed = true, capture?: () => CurrentCallAttachment | null) {
  let connected = true;
  let account = true;
  let record: WebCallRecord | null = null;
  let ids: WebCallIds | undefined;
  const row: WebCallSituation = { state: 'awaiting_browser', legState: 'created', ack: null };
  const sent = vi.fn(async () => ({ ok: true, error: null }));
  const prepare = vi.fn((_type: string, _payload: unknown) => ({ commandId: 'cmd_test', send: sent }));
  const store = {
    find: vi.fn(async () => record),
    locateSim: vi.fn(async () => 'device'),
    reserve: vi.fn(async (identity: WebCallIds) => {
      ids = identity;
      record = { id: identity.id, simId, to: request.to, kind: 'web_out' };
      return { sim: { slot: 0, subId: 1 } };
    }),
    compensateReservation: vi.fn(async (_ids: WebCallIds, _key: string) => {}),
    arm: vi.fn(async (_ids: WebCallIds, _simId: string, _sim: unknown, _command: string, current: () => boolean) => {
      expect(current()).toBe(true);
      row.state = 'cell_dialing';
      return true;
    }),
    acknowledge: vi.fn(async (_ids: WebCallIds, _command: string, result: string) => { row.ack = result; }),
    situation: vi.fn(async () => ({ ...row })),
    bridge: vi.fn(async (_ids: WebCallIds, current: () => boolean) => {
      if (!current()) return false;
      row.state = 'bridged';
      return true;
    }),
    finish: vi.fn(async (_ids: WebCallIds, _reason: string, control?: { type: string }) => {
      if (control?.type === 'call.hangup') row.state = 'ending';
      else if (!control && row.state !== 'ended') row.state = row.state === 'awaiting_browser' ? 'ended' : 'unknown';
      return true;
    }),
  };
  const media = new MediaTransport(async token => token === 'device-test' ? { id: 'device', enabled: true } : null);
  const calls = new WebCalls({ store, media, automatic: false,
    capture: capture ?? (() => allowed ? { connectionId: 'process-connection', current: () => connected, prepare } : null),
    summary: async id => ({ id, state: row.state }), authorizeOwner: async () => account ? Date.now() + 60_000 : null, update: vi.fn() });
  closers.push(async () => { await calls.stop(); media.close(); await media.drain(); });
  return { calls, store, media, row, sent, prepare,
    identifiers: () => ids!, disconnect: () => { connected = false; }, expire: () => { account = false; } };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
  vi.useRealTimers();
});

function openBrowser(f: ReturnType<typeof fixture>, data: Awaited<ReturnType<WebCalls['create']>>) {
  const socket = makeSocket();
  const browser = f.media.open(socket, data.browserLeg.mediaPath);
  browser.message(bytes({ type: 'auth', token: data.browserLeg.mediaToken }), false);
  return { socket, browser };
}

const step = async (f: ReturnType<typeof fixture>, ms = 0) => {
  vi.setSystemTime(Date.now() + ms);
  f.calls.tick();
  await Promise.resolve();
  await vi.advanceTimersByTimeAsync(1);
};

describe('browser call orchestration', () => {
  it('requires independent authorization before allocating any call or media leg', async () => {
    const f = fixture(false);
    await expect(f.calls.create(request, 'owner')).rejects.toThrow('CAPABILITY_UNSUPPORTED');
    expect(f.store.reserve).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('waits for a browser frame, holds the durable attempt before dispatch, and waits for active and both media legs', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const f = fixture();
    const first = f.calls.create(request, 'owner');
    expect(f.calls.create(request, 'owner')).toBe(first);
    const data = await first;
    expect(await f.calls.create(request, 'owner')).toEqual(data);
    await expect(f.calls.create({ ...request, to: '23456' }, 'owner')).rejects.toThrow('CONFLICT');
    const { browser, socket } = openBrowser(f, data);
    await step(f);
    expect(f.prepare).not.toHaveBeenCalled();
    await expect(f.calls.create(request, 'different')).rejects.toThrow('TIMEOUT_UNKNOWN');
    browser.message(silence(), true);
    await step(f, 300);
    const ids = f.identifiers();
    expect(f.prepare).toHaveBeenCalledExactlyOnceWith('call.dial', expect.objectContaining({ callId: ids.callId, generation: ids.generation }));
    expect(f.store.arm.mock.invocationCallOrder[0]!).toBeLessThan(f.sent.mock.invocationCallOrder[0]!);
    expect(f.store.acknowledge).toHaveBeenCalledWith(ids, 'cmd_test', 'ok');
    f.row.legState = 'active';
    await step(f, 300);
    expect(f.store.bridge).not.toHaveBeenCalled();
    const device = f.media.open(makeSocket(), '/ws/media?' + new URLSearchParams({ session: ids.id, leg: ids.cellularLegId }), 'Bearer device-test');
    await f.media.drain();
    device.message(silence(), true);
    await step(f, 300);
    expect(f.row.state).toBe('bridged');
    await step(f, 20);
    expect(socket.send).toHaveBeenCalled();
    await f.calls.control(ids.id, 'owner', 'call.dtmf', '1#');
    expect(f.prepare).toHaveBeenLastCalledWith('call.dtmf', { callId: ids.callId, generation: ids.generation, digits: '1#' });
    await f.calls.control(ids.id, 'owner', 'call.hangup');
    expect(f.row.state).toBe('ending');
    f.row.state = 'ended';
    await step(f, 300);
    expect(socket.close).toHaveBeenCalledWith(4404);
    expect(f.sent).toHaveBeenCalledTimes(3);
  });

  it('never dials on a lost owner, a replaced attachment, or browser readiness expiry', async () => {
    vi.useFakeTimers({ now: 100_000 });
    for (const lose of [(f: ReturnType<typeof fixture>) => f.expire(), (f: ReturnType<typeof fixture>) => f.disconnect(), () => vi.setSystemTime(Date.now() + 10_001)]) {
      const f = fixture();
      const data = await f.calls.create(request, 'owner');
      const { browser } = openBrowser(f, data);
      browser.message(silence(), true);
      lose(f);
      await step(f);
      expect(f.sent).not.toHaveBeenCalled();
      expect(f.row.state).toBe('ended');
    }
  });

  it('does not send after logout during the durable dial reservation', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const f = fixture();
    const data = await f.calls.create(request, 'owner');
    openBrowser(f, data).browser.message(silence(), true);
    f.store.arm.mockImplementationOnce(async () => {
      f.row.state = 'cell_dialing';
      f.expire();
      return true;
    });
    await step(f);
    expect(f.sent).not.toHaveBeenCalled();
    expect(f.store.acknowledge).toHaveBeenCalledWith(f.identifiers(), 'cmd_test', 'unknown');
  });

  it('revokes a creation while its reservation is still settling', async () => {
    const f = fixture();
    const original = f.store.reserve.getMockImplementation()!;
    f.store.reserve.mockImplementationOnce(async ids => {
      f.calls.revokeOwner('owner');
      return original(ids);
    });
    await expect(f.calls.create(request, 'owner')).rejects.toThrow('CAPABILITY_UNSUPPORTED');
    expect(f.store.finish).toHaveBeenCalledWith(f.identifiers(), 'browser_provision_failed');
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('serializes an early hangup behind a pending progress lookup and never dials afterwards', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const f = fixture();
    const data = await f.calls.create(request, 'owner');
    openBrowser(f, data).browser.message(silence(), true);
    let resolve!: (value: WebCallSituation) => void;
    f.store.situation.mockImplementationOnce(() => new Promise(r => { resolve = r; }));
    await step(f);
    const hangup = f.calls.control(f.identifiers().id, 'owner', 'call.hangup');
    resolve({ ...f.row });
    await hangup;
    expect(f.row.state).toBe('ended');
    expect(f.sent).not.toHaveBeenCalled();
  });

  it('tries to settle a lost reservation reply without preparing a device command', async () => {
    const f = fixture();
    f.store.reserve.mockRejectedValueOnce(new Error('lost reservation reply'));
    await expect(f.calls.create(request, 'owner')).rejects.toThrow('lost reservation reply');
    expect(f.store.compensateReservation).toHaveBeenCalledWith(expect.objectContaining({ deviceId: 'device' }), request.key);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('records an uncertain command exactly once without issuing another dial', async () => {
    vi.useFakeTimers({ now: 100_000 });
    const f = fixture();
    f.sent.mockRejectedValueOnce(new Error('transport closed'));
    const data = await f.calls.create(request, 'owner');
    openBrowser(f, data).browser.message(silence(), true);
    await step(f);
    await step(f, 500);
    expect(f.sent).toHaveBeenCalledOnce();
    expect(f.store.acknowledge).toHaveBeenCalledWith(f.identifiers(), 'cmd_test', 'unknown');
    expect(f.row.state).toBe('unknown');
  });
});

it('bridges an authenticated generated call through the actual HTTP, command and media handlers', async () => {
  vi.useFakeTimers({ now: 1_700_000_000_000, toFake: ['Date'] });
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const advance = async (ms = 0) => {
    vi.setSystemTime(Date.now() + ms);
    f.calls.tick();
    await settle();
  };
  const commands = new DeviceCommands();
  const f = fixture(true, () => commands.captureCallAttachment('device'));
  const observed: Array<{ type: string; id: string; payload: Record<string, unknown> }> = [];
  const event = (type: string, payload: object) => JSON.stringify({
    v: 1, id: 'evt_' + ulid(), ts: Date.now(), type, payload,
  });
  const sessions = new DeviceSessions({ commands, heartbeatSec: 30, locale: 'en',
    authenticate: async token => token === 'device-test' ? { id: 'device', enabled: true } : null,
    heartbeat: async () => {},
    onEvent: async (id, input, context) => {
      const message = input as typeof observed[number];
      const reserved = f.identifiers();
      if (id !== 'device' || !context.callGeneration || !context.isCurrent() ||
          context.connectionId !== reserved.connectionId || message.type !== 'call.state' ||
          message.payload.callId !== reserved.callId || message.payload.generation !== reserved.generation) return false;
      f.row.legState = String(message.payload.state);
      if (f.row.legState === 'disconnected') f.row.state = 'ended';
      return true;
    },
  });
  const session = sessions.open({ send: raw => observed.push(JSON.parse(raw)), close() {} });
  const app = Fastify();
  registerWebCallRoutes(app, { calls: f.calls, available: () => ['device'], authenticate: async () => 'admin' });
  try {
    const hello = { token: 'device-test', protocol: 1, apkVersion: 'test', apkCode: 1, manufacturer: 'Synthetic',
      model: 'Memory test', apiLevel: 34, locale: 'en', capabilities: { callGeneration: true } };
    await session.message(event('hello', hello));
    expect(observed[0]?.type).toBe('hello.ok');
    const headers = { authorization: 'Bearer admin-test', 'idempotency-key': request.key };
    const reservation = await app.inject({ method: 'POST', url: '/api/calls', headers, payload: { simId, to: request.to } });
    expect(reservation.statusCode).toBe(200);
    const data = reservation.json().data as Awaited<ReturnType<WebCalls['create']>>;
    const { browser, socket } = openBrowser(f, data);
    browser.message(silence(), true);
    await advance();
    const dial = observed.find(m => m.type === 'call.dial')!;
    expect(dial).toBeDefined();
    const ids = f.identifiers();
    expect(dial.payload).toMatchObject({ callId: ids.callId, generation: ids.generation, to: request.to });
    expect(f.store.arm).toHaveBeenCalledWith(ids, simId, { slot: 0, subId: 1 }, dial.id, expect.any(Function));
    await session.message(event('ack', { refId: 'cmd_' + ulid(), ok: true, error: null }));
    expect(f.store.acknowledge).not.toHaveBeenCalled();
    await session.message(event('ack', { refId: dial.id, ok: true, error: null }));
    await settle();
    expect(f.row.ack).toBe('ok');
    const deviceSocket = makeSocket();
    const media = f.media.open(deviceSocket, (dial.payload.media as { path: string }).path, 'Bearer device-test');
    await f.media.drain();
    media.message(silence(), true);
    await session.message(event('call.state', { callId: ids.callId, generation: 'gen_' + ulid(), state: 'active', cause: null }));
    await advance(300);
    expect(f.row.state).toBe('cell_dialing');
    await session.message(event('call.state', { callId: ids.callId, generation: ids.generation, state: 'active', cause: null }));
    await advance(300);
    expect(f.row.state).toBe('bridged');
    await advance(20);
    expect(socket.send).toHaveBeenCalled();
    expect(deviceSocket.send).toHaveBeenCalled();
    await session.message(event('call.state', { callId: ids.callId, generation: ids.generation, state: 'disconnected', cause: 'remote_hangup' }));
    await advance(300);
    expect(socket.close).toHaveBeenCalledWith(4404);
    expect(observed.filter(message => message.type === 'call.dial')).toHaveLength(1);
  } finally {
    session.close();
    await sessions.stop();
    await app.close();
  }
});

it('requires authorization, a valid request and an idempotency key at the actual HTTP endpoint', async () => {
  const f = fixture(false);
  const app = Fastify();
  registerWebCallRoutes(app, { authenticate: async token => token === 'test' ? 'admin' : null, available: () => [], calls: f.calls });
  try {
    expect((await app.inject({ url: '/api/calls/availability' })).statusCode).toBe(401);
    const headers = { authorization: 'Bearer test' };
    const availability = await app.inject({ url: '/api/calls/availability', headers });
    expect(availability.json()).toEqual({ data: { deviceIds: [] } });
    expect(availability.headers['cache-control']).toBe('no-store');
    const post = (key?: string) => app.inject({ method: 'POST', url: '/api/calls',
      headers: { ...headers, ...(key ? { 'idempotency-key': key } : {}) }, payload: { simId, to: request.to } });
    expect((await post()).json().error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    expect((await post('safe-key')).json().error.code).toBe('CAPABILITY_UNSUPPORTED');
    expect(f.store.reserve).not.toHaveBeenCalled();
  } finally { await app.close(); }
});
