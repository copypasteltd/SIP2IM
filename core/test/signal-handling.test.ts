import { describe, expect, it, vi } from 'vitest';
import { runWithSignals, type ShutdownSignal } from '../src/signal-handling.js';

class FakeSignals {
  private listeners = new Map<ShutdownSignal, Set<() => void>>();
  on(signal: ShutdownSignal, listener: () => void) {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }
  off(signal: ShutdownSignal, listener: () => void) { this.listeners.get(signal)?.delete(listener); }
  emit(signal: ShutdownSignal) { for (const listener of this.listeners.get(signal) ?? []) listener(); }
  count() { return [...this.listeners.values()].reduce((n, listeners) => n + listeners.size, 0); }
}

describe('signal coordinator', () => {
  it.each(['SIGINT', 'SIGTERM'] as const)('handles repeated %s and the other signal once', async signal => {
    const source = new FakeSignals();
    const cleanup = vi.fn();
    const done = runWithSignals(source, () => {}, cleanup);
    source.emit(signal);
    source.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    source.emit(signal);
    expect(await done).toMatchObject({ signal, startupFailed: false, cleanupFailed: false });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.count()).toBe(0);
    source.emit(signal);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('fences new admission synchronously when a runtime prerequisite disappears', async () => {
    const source = new FakeSignals();
    let stop!: () => void;
    let admission!: AbortSignal;
    const cleanup = vi.fn();
    const result = runWithSignals(source, (signal, requestStop) => {
      admission = signal;
      stop = requestStop;
    }, cleanup);
    expect(admission.aborted).toBe(false);
    stop();
    expect(admission.aborted).toBe(true);
    source.emit('SIGTERM');
    expect(await result).toMatchObject({ signal: undefined, startupFailed: false, cleanupFailed: false });
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it('waits for startup to settle before cleaning resources created during startup', async () => {
    const source = new FakeSignals();
    const calls: string[] = [];
    let finish!: () => void;
    const startup = new Promise<void>(resolve => { finish = resolve; });
    const done = runWithSignals(source, async () => { calls.push('start'); await startup; calls.push('acquired'); }, () => { calls.push('cleanup'); });
    source.emit('SIGTERM');
    await Promise.resolve();
    expect(calls).toEqual(['start']);
    finish();
    expect(await done).toMatchObject({ signal: 'SIGTERM', startupFailed: false });
    expect(calls).toEqual(['start', 'acquired', 'cleanup']);
  });

  it('preserves startup and cleanup failures when a signal arrives during failed startup', async () => {
    const source = new FakeSignals();
    const startError = new Error('start');
    const closeError = new Error('close');
    let fail!: (error: unknown) => void;
    const startup = new Promise<void>((_resolve, reject) => { fail = reject; });
    const cleanup = vi.fn(() => { throw closeError; });
    const done = runWithSignals(source, () => startup, cleanup);
    source.emit('SIGINT');
    fail(startError);
    expect(await done).toEqual({ signal: 'SIGINT', startupFailed: true, startupError: startError, cleanupFailed: true, cleanupError: closeError });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.count()).toBe(0);
  });

  it('fences admission before cleanup after startup failure without a signal', async () => {
    const source = new FakeSignals();
    let admission!: AbortSignal;
    const cleanup = vi.fn(() => { expect(admission.aborted).toBe(true); });
    const done = runWithSignals(source, signal => { admission = signal; throw undefined; }, cleanup);
    expect(await done).toMatchObject({ startupFailed: true, startupError: undefined, cleanupFailed: false });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(source.count()).toBe(0);
  });

  it('reports asynchronous cleanup rejection and removes listeners', async () => {
    const source = new FakeSignals();
    const error = new Error('cleanup');
    const done = runWithSignals(source, () => {}, async () => { throw error; });
    source.emit('SIGTERM');
    expect(await done).toMatchObject({ cleanupFailed: true, cleanupError: error });
    expect(source.count()).toBe(0);
  });

  it('rolls back the first listener when registering the second fails', () => {
    const source = new FakeSignals();
    const original = source.on.bind(source);
    const failure = new Error('registration');
    vi.spyOn(source, 'on').mockImplementation((signal, listener) => {
      if (signal === 'SIGTERM') throw failure;
      original(signal, listener);
    });
    const start = vi.fn();
    expect(() => runWithSignals(source, start, vi.fn())).toThrow(failure);
    expect(start).not.toHaveBeenCalled();
    expect(source.count()).toBe(0);
  });
});
