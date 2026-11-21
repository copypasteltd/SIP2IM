import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import { startAdminSocket, syncEvent } from './admin-socket';
import { useLoginSteps } from './login-steps';

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); useLoginSteps.getState().clearAll(); });
it('authenticates first, clears retired prompts, and refreshes on reconnect without replay', () => {
  vi.useFakeTimers();
  const sockets: FakeSocket[] = [];
  class FakeSocket {
    static OPEN = 1;
    readyState = 1;
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onmessage: ((event: { data: string }) => void) | null = null;
    sent: string[] = [];
    constructor(public url: string) { sockets.push(this); }
    send(value: string) { this.sent.push(value); }
    close() { this.onclose?.(); }
    receive(type: string, data?: unknown) { this.onmessage?.({ data: JSON.stringify({ type, data }) }); }
  }
  vi.stubGlobal('WebSocket', FakeSocket);
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const states: string[] = [];
  const stop = startAdminSocket('fixture-token', client, state => states.push(state));
  const first = sockets[0];
  const staleMessage = first.onmessage!;
  const staleClose = first.onclose!;
  const step = { platform: 'telegram', step: 'code', qrPngBase64: null, hint: null };
  const store = useLoginSteps.getState();
  expect(first.url).not.toContain('fixture-token');
  first.onopen?.();
  expect(first.sent.map(frame => JSON.parse(frame))).toEqual([{ type: 'auth', token: 'fixture-token' }, { type: 'ping' }]);
  first.receive('pong');
  expect(states.at(-1)).toBe('connected');
  const command = { kind: 'start' as const };
  store.begin('telegram', command);
  store.accept('telegram', command);
  first.receive('channel.login.step', step);
  expect(useLoginSteps.getState().steps.telegram?.step).toBe('code');
  first.close();
  expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
  expect(useLoginSteps.getState().progress.telegram?.phase).toBe('missed');
  vi.advanceTimersByTime(1000);
  sockets[1].onopen?.();
  sockets[1].receive('pong');
  expect(invalidate).toHaveBeenCalledWith();
  sockets[1].receive('channel.login.step', step);
  staleMessage({ data: JSON.stringify({ type: 'channel.login.step', data: step }) });
  staleClose();
  expect(useLoginSteps.getState().steps.telegram).toBeUndefined();
  expect(useLoginSteps.getState().progress.telegram?.phase).toBe('missed');
  expect(states.at(-1)).toBe('connected');
  expect(sockets[1].sent.map(frame => JSON.parse(frame).type)).toEqual(['auth', 'ping']);
  stop();
});

it('invalidates affected caches for SMS events', () => {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  syncEvent(client, 'sms.new'); syncEvent(client, 'sms.task.updated');
  expect(invalidate).toHaveBeenCalledTimes(2);
  expect(invalidate).toHaveBeenCalledWith({ queryKey: ['sms'] });
});
