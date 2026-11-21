import { WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { websocketServerCloser } from '../src/ws-server-close.js';

afterEach(() => vi.useRealTimers());

it('requests close once and gates cleanup until the callback after client drains', async () => {
  let done!: (error?: Error) => void;
  const order: string[] = [];
  const server = { close: vi.fn((callback: (error?: Error) => void) => { order.push('request'); done = callback; }) };
  const closer = websocketServerCloser(server);
  const lifecycle = new Lifecycle();
  lifecycle.defer(() => { order.push('pool'); }, { requiresCriticalSuccess: true });
  lifecycle.defer(() => closer.wait(), { critical: true });
  lifecycle.defer(() => { order.push('media'); }, { critical: true });
  lifecycle.defer(() => { order.push('sessions'); }, { critical: true });
  lifecycle.defer(() => closer.start(), { critical: true });
  closer.start(); closer.start();
  const closing = lifecycle.close();
  await vi.waitFor(() => expect(order).toEqual(['request', 'sessions', 'media']));
  done();
  await closing;
  expect(order).toEqual(['request', 'sessions', 'media', 'pool']);
  expect(server.close).toHaveBeenCalledOnce();
  await closer.wait();
});

it('propagates asynchronous callback failure and protects the pool', async () => {
  let done!: (error?: Error) => void;
  const failure = new Error('close failed');
  const closer = websocketServerCloser({ close: callback => { done = callback; } });
  const pool = vi.fn(); const lifecycle = new Lifecycle();
  lifecycle.defer(pool, { requiresCriticalSuccess: true });
  lifecycle.defer(() => closer.wait(), { critical: true });
  lifecycle.defer(() => closer.start());
  const closing = lifecycle.close();
  await vi.waitFor(() => expect(done).toBeDefined());
  done(failure);
  await expect(closing).rejects.toMatchObject({ errors: [failure] });
  expect(pool).not.toHaveBeenCalled();
  await expect(closer.wait()).rejects.toBe(failure);
});

it('terminates lingering clients and rejects if close still never completes', async () => {
  vi.useFakeTimers();
  const terminate = vi.fn();
  const closer = websocketServerCloser({ close: vi.fn(), clients: new Set([{ terminate }]) }, 10, 20);
  const result = closer.wait();
  const rejected = expect(result).rejects.toThrow('WebSocket server close timed out');
  await vi.advanceTimersByTimeAsync(10);
  expect(terminate).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(20);
  await rejected;
});

it('awaits the actual noServer close callback without opening a listener', async () => {
  const server = new WebSocketServer({ noServer: true });
  const closer = websocketServerCloser(server);
  closer.start();
  await closer.wait();
  await closer.wait();
});

it('attempts every termination and reports errors after the close callback', async () => {
  vi.useFakeTimers();
  let done!: (error?: Error) => void;
  const failure = new Error('termination failed');
  const first = vi.fn(() => { throw failure; });
  const second = vi.fn(() => done());
  const closer = websocketServerCloser({ close: callback => { done = callback; }, clients: new Set([{ terminate: first }, { terminate: second }]) }, 10, 20);
  const result = closer.wait();
  const rejected = expect(result).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(10);
  expect(first).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledOnce();
  await rejected;
});

it('partial startup cleanup starts close and waits before releasing the pool', async () => {
  let done!: (error?: Error) => void;
  const closer = websocketServerCloser({ close: callback => { done = callback; } });
  const pool = vi.fn(); const sessions = vi.fn(); const lifecycle = new Lifecycle();
  lifecycle.defer(pool, { requiresCriticalSuccess: true });
  lifecycle.defer(sessions, { critical: true });
  lifecycle.defer(() => closer.wait(), { critical: true });
  const closing = lifecycle.close();
  await vi.waitFor(() => expect(done).toBeDefined());
  expect(pool).not.toHaveBeenCalled();
  done();
  await closing;
  expect(sessions).toHaveBeenCalledOnce();
  expect(pool).toHaveBeenCalledOnce();
});

it('rejects if close throws undefined', async () => {
  const closer = websocketServerCloser({ close: () => { throw undefined; } });
  await expect(closer.wait()).rejects.toThrow('WebSocket shutdown threw a non-Error value');
});

it('reports undefined termination throws after attempting all clients', async () => {
  vi.useFakeTimers();
  let done!: (error?: Error) => void;
  const second = vi.fn(() => done());
  const closer = websocketServerCloser({ close: callback => { done = callback; }, clients: new Set([{ terminate: () => { throw undefined; } }, { terminate: second }]) }, 10, 20);
  const rejection = expect(closer.wait()).rejects.toThrow('WebSocket shutdown threw a non-Error value');
  await vi.advanceTimersByTimeAsync(10);
  expect(second).toHaveBeenCalledOnce();
  await rejection;
});
