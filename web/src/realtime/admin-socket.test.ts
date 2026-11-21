import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { startAdminSocket, syncEvent } from './admin-socket';
import { useLoginSteps } from './login-steps';

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); vi.unstubAllGlobals(); useLoginSteps.getState().clearAll(); });

function fixture(ownsSession = () => true) {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
  let elapsed = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => elapsed);
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    sent: unknown[] = [];
    constructor(public url: string) { sockets.push(this); }
    send = vi.fn((value: string) => { this.sent.push(JSON.parse(value)); });
    close = vi.fn(() => { this.readyState = 2; }); // No transport close event.
    open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
    receive(type: string, data?: unknown) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
    remoteClose() { this.readyState = 3; this.onclose?.(); }
    error() { this.onerror?.(); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const states: string[] = [];
  const stop = startAdminSocket('fixture-token', client, state => states.push(state), ownsSession);
  const advance = (ms: number) => { elapsed += ms; vi.advanceTimersByTime(ms); };
  return { sockets, invalidate, states, stop, advance, elapseWithoutTimers: (ms: number) => { elapsed += ms; } };
}

const step = { platform: 'telegram', challengeId: '00000000-0000-4000-8000-000000000001', step: 'code', qrPngBase64: null, hint: null };
const firstFrames = [{ type: 'auth', token: 'fixture-token' }, { type: 'ping' }];

it('authenticates first, clears retired prompts, and refreshes once on reconnect without replay', () => {
  const { sockets, invalidate, states, stop, advance } = fixture();
  try {
    const [first] = sockets;
    const staleMessage = first.onmessage!;
    const staleClose = first.onclose!;
    const store = useLoginSteps.getState();
    expect(first.url).not.toContain('fixture-token');
    first.receive('pong'); // Before open or ping.
    expect(states).toEqual(['connecting']);
    expect(first.sent).toEqual([]);
    first.open();
    first.open(); // A second open notification cannot resend auth.
    expect(states.at(-1)).toBe('connecting');
    expect(first.sent).toEqual(firstFrames);
    first.receive('channel.updated', { platform: 'telegram', state: 'logged_in' });
    expect(invalidate).not.toHaveBeenCalled();
    first.receive('pong');
    expect(states.at(-1)).toBe('connected');
    const command = { kind: 'start' as const };
    store.begin('telegram', command);
    store.accept('telegram', command);
    first.receive('channel.login.step', { ...step, challengeId: undefined });
    expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
    first.receive('channel.login.step', step);
    expect(useLoginSteps.getState().steps.telegram).toMatchObject({ step: 'code', challengeId: step.challengeId });
    first.remoteClose();
    expect(first.close).not.toHaveBeenCalled();
    expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
    expect(useLoginSteps.getState().progress.telegram?.phase).toBe('missed');
    invalidate.mockClear();
    advance(1000);
    sockets[1].open();
    sockets[1].receive('pong');
    sockets[1].receive('pong');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith();
    sockets[1].receive('channel.login.step', step);
    staleMessage({ data: JSON.stringify({ type: 'channel.login.step', data: step }) });
    staleClose();
    expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
    expect(useLoginSteps.getState().progress.telegram?.phase).toBe('missed');
    expect(states).toEqual(['connecting', 'connected', 'disconnected', 'connecting', 'connected']);
    expect(sockets[1].sent).toEqual(firstFrames);
  } finally { stop(); }
});

it('retires a socket that never opens and retries without any close callback', () => {
  const { sockets, states, invalidate, advance, stop } = fixture();
  try {
    const [first] = sockets;
    const oldOpen = first.onopen!, oldMessage = first.onmessage!, oldError = first.onerror!, oldClose = first.onclose!;
    advance(9999);
    expect(first.close).not.toHaveBeenCalled();
    advance(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'disconnected']);
    expect([first.onopen, first.onmessage, first.onerror, first.onclose]).toEqual([null, null, null, null]);
    oldOpen(); oldClose(); oldError();
    oldMessage({ data: JSON.stringify({ type: 'pong' }) });
    expect(first.sent).toEqual([]);
    expect(invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    advance(999);
    expect(sockets).toHaveLength(1);
    advance(1);
    expect(sockets).toHaveLength(2);
    expect(states).toEqual(['connecting', 'disconnected', 'connecting']);
  } finally { stop(); }
  expect(vi.getTimerCount()).toBe(0);
});

it.each(['open', 'pong'] as const)('refuses a %s at its deadline before the timer callback runs', late => {
  const { sockets, invalidate, states, stop, advance, elapseWithoutTimers } = fixture();
  try {
    const [first] = sockets;
    advance(9000);
    if (late === 'pong') {
      first.open();
      advance(9999);
      expect(first.close).not.toHaveBeenCalled();
      elapseWithoutTimers(1);
      first.receive('pong');
      expect(first.sent).toEqual(firstFrames);
    } else {
      elapseWithoutTimers(1000);
      first.open();
      expect(first.sent).toEqual([]);
    }
    expect(first.close).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'disconnected']);
    expect(invalidate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  } finally { stop(); }
});

it('retries an opened connection that never receives its first pong', () => {
  const { sockets, states, stop, advance } = fixture();
  try {
    const [first] = sockets;
    advance(9000);
    first.open();
    advance(9999);
    expect(first.close).not.toHaveBeenCalled();
    expect(first.sent).toEqual(firstFrames);
    advance(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe('disconnected');
    advance(1000);
    expect(sockets).toHaveLength(2);
  } finally { stop(); }
});

it('uses monotonic freshness, limits outstanding pings, and ignores unsolicited pongs', () => {
  const { sockets, states, stop, advance } = fixture();
  try {
    const [first] = sockets;
    first.open(); first.receive('pong');
    vi.setSystemTime(Date.now() + 86_400_000);
    advance(25_000);
    expect(first.sent).toEqual([...firstFrames, { type: 'ping' }]);
    expect(states.at(-1)).toBe('connected');
    advance(5000);
    first.receive('pong'); // The only pong in this interval that renews freshness.
    vi.setSystemTime(Date.now() - 172_800_000);
    advance(15_000);
    first.receive('pong'); // No outstanding ping: cannot extend the deadline.
    advance(5000);
    expect(first.sent).toEqual([...firstFrames, { type: 'ping' }, { type: 'ping' }]);
    advance(25_000);
    expect(first.sent).toHaveLength(4);
    advance(14_999);
    expect(first.close).not.toHaveBeenCalled();
    advance(1);
    expect(first.close).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'connected', 'disconnected']);
  } finally { stop(); }
});

it('rejects events and a late heartbeat pong before running a throttled freshness timer', () => {
  const { sockets, invalidate, states, stop, advance, elapseWithoutTimers } = fixture();
  try {
    const [first] = sockets;
    first.open(); first.receive('pong');
    const stale = first.onmessage!;
    advance(25_000);
    elapseWithoutTimers(35_000);
    first.receive('sms.new');
    stale({ data: JSON.stringify({ type: 'pong' }) });
    expect(invalidate).not.toHaveBeenCalled();
    expect(first.close).toHaveBeenCalledOnce();
    expect(states.at(-1)).toBe('disconnected');
    expect(vi.getTimerCount()).toBe(1);
  } finally { stop(); }
});

it.each(['error', 'send'] as const)('retires locally on %s failure even when close throws', reason => {
  const { sockets, states, stop, advance } = fixture();
  try {
    const [first] = sockets;
    first.close.mockImplementationOnce(() => { throw Error('fixture close failure'); });
    const staleClose = first.onclose!;
    if (reason === 'error') first.error();
    else {
      first.send.mockImplementationOnce(() => { throw Error('fixture send failure'); });
      first.open();
      expect(first.send).toHaveBeenCalledOnce();
    }
    expect(first.close).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'disconnected']);
    staleClose();
    advance(1000);
    expect(sockets).toHaveLength(2);
    expect(states).toEqual(['connecting', 'disconnected', 'connecting']);
  } finally { stop(); }
});

it('keeps unknown writes blocked across retries and does not let old session cleanup change the new one', () => {
  let owner = true;
  const { sockets, invalidate, states, stop, advance } = fixture(() => owner);
  try {
    const [first] = sockets;
    first.open(); first.receive('pong');
    const command = { kind: 'submit' as const };
    const store = useLoginSteps.getState();
    store.begin('telegram', command);
    store.reject('telegram', command, true);
    first.error();
    expect(useLoginSteps.getState().progress.telegram).toEqual({ phase: 'uncertain', operation: command });
    advance(1000);
    const next = sockets[1], late = next.onmessage!;
    next.open(); next.receive('pong');
    next.receive('channel.updated', { platform: 'telegram', state: 'logged_in' });
    expect(useLoginSteps.getState().progress.telegram).toEqual({ phase: 'uncertain', operation: command });
    expect(next.sent).toEqual(firstFrames);
    owner = false;
    const snapshot = useLoginSteps.getState(), calls = invalidate.mock.calls.length, observed = [...states];
    stop(); stop();
    late({ data: JSON.stringify({ type: 'channel.updated', data: { platform: 'telegram', state: 'logged_out' } }) });
    advance(60_000);
    expect(useLoginSteps.getState()).toBe(snapshot);
    expect(invalidate.mock.calls).toHaveLength(calls);
    expect(states).toEqual(observed);
    expect(next.close).toHaveBeenCalledOnce();
    expect(sockets).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  } finally { stop(); }
});

it('bounds reconnect backoff and resets it only after a timely first pong', () => {
  const { sockets, states, invalidate, advance, stop } = fixture();
  try {
    for (const [i, wait] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
      sockets[i].open(); sockets[i].error();
      advance(wait - 1);
      expect(sockets).toHaveLength(i + 1);
      advance(1);
      expect(sockets).toHaveLength(i + 2);
    }
    expect(invalidate).not.toHaveBeenCalled();
    const ready = sockets.at(-1)!;
    ready.open(); ready.receive('pong');
    expect(states.at(-1)).toBe('connected');
    expect(invalidate).toHaveBeenCalledTimes(1);
    const afterReady = sockets.length;
    ready.error();
    advance(999);
    expect(sockets).toHaveLength(afterReady);
    advance(1);
    expect(sockets).toHaveLength(afterReady + 1);
  } finally { stop(); }
});

it.each(['throw', 'reject'] as const)('finishes reconnect even if cache refresh fails by %s', async failure => {
  const { sockets, invalidate, states, stop, advance } = fixture();
  try {
    sockets[0].error();
    advance(1000);
    const next = sockets[1];
    const error = Error('synthetic refresh failure');
    if (failure === 'throw') invalidate.mockImplementationOnce(() => { throw error; });
    else invalidate.mockRejectedValueOnce(error);
    next.open(); next.receive('pong');
    expect(states.at(-1)).toBe('connected');
    expect(invalidate).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    advance(25_000);
    next.receive('pong');
    expect(next.close).not.toHaveBeenCalled();
    next.receive('sms.new');
    expect(invalidate).toHaveBeenLastCalledWith({ queryKey: ['sms'] });
  } finally { stop(); }
});

it('disposes a timed out attempt owned by a retired session without touching new state', () => {
  let owner = true;
  const { sockets, states, stop, advance, invalidate } = fixture(() => owner);
  try {
    const first = sockets[0], oldMessage = first.onmessage!;
    first.open(); first.receive('pong');
    owner = false;
    const before = useLoginSteps.getState();
    advance(60_000);
    oldMessage({ data: JSON.stringify({ type: 'sms.new' }) });
    expect(first.close).toHaveBeenCalledOnce();
    expect(states).toEqual(['connecting', 'connected']);
    expect(useLoginSteps.getState()).toBe(before);
    expect(invalidate).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally { stop(); }
});

it.each(['accepted', 'unknown'] as const)('retains the original pending login write across local retirement (%s)', outcome => {
  const { sockets, stop, advance } = fixture();
  try {
    const first = sockets[0];
    first.open(); first.receive('pong');
    const command = { kind: 'submit' as const };
    const store = useLoginSteps.getState();
    store.begin('telegram', command);
    first.receive('channel.login.step', step);
    expect(useLoginSteps.getState().progress.telegram).toMatchObject({ phase: 'waiting', operation: command, candidate: { challengeId: step.challengeId } });
    first.error();
    expect(useLoginSteps.getState().progress.telegram).toEqual({ phase: 'missed', operation: command });
    expect(useLoginSteps.getState().progress.telegram?.operation).toBe(command);
    expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
    advance(1000);
    const next = sockets[1];
    next.open(); next.receive('pong');
    next.receive('channel.login.step', step);
    next.receive('channel.updated', { platform: 'telegram', state: 'logged_in' });
    expect(useLoginSteps.getState().progress.telegram?.operation).toBe(command);
    if (outcome === 'accepted') store.accept('telegram', command);
    else store.reject('telegram', command, true);
    expect(useLoginSteps.getState().progress.telegram).toEqual(outcome === 'accepted'
      ? { phase: 'missed' }
      : { phase: 'uncertain', operation: command });
    expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
    expect(next.sent).toEqual(firstFrames);
  } finally { stop(); }
});

it('cancels a scheduled retry when stopped and cannot restart from a retired callback', () => {
  const { sockets, states, stop, advance } = fixture();
  const [first] = sockets;
  const oldClose = first.onclose!;
  first.error();
  expect(vi.getTimerCount()).toBe(1);
  stop(); stop();
  const stoppedStates = [...states];
  oldClose();
  advance(60_000);
  expect(vi.getTimerCount()).toBe(0);
  expect(states).toEqual(stoppedStates);
  expect(sockets).toHaveLength(1);
  expect(first.close).toHaveBeenCalledOnce();
});

it('invalidates affected caches for SMS events', () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  syncEvent(client, 'sms.new'); syncEvent(client, 'sms.task.updated');
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sms'] });
});
