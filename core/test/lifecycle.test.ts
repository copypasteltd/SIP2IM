import { describe, expect, it, vi } from 'vitest';
import { drainAll, Lifecycle, startWithCleanup } from '../src/lifecycle.js';

describe('critical drains', () => {
  it('attempts independent drains and keeps the pool open on failure', async () => {
    const lifecycle = new Lifecycle();
    const failure = new Error('unknown stop outcome');
    const pool = vi.fn();
    const second = vi.fn();
    const independent = vi.fn();
    lifecycle.defer(pool, { requiresCriticalSuccess: true });
    lifecycle.defer(independent);
    lifecycle.defer(() => drainAll([() => { throw failure; }, second]), { critical: true });
    await expect(lifecycle.close()).rejects.toMatchObject({ errors: [expect.objectContaining({ errors: [failure] })] });
    expect(second).toHaveBeenCalledOnce();
    expect(independent).toHaveBeenCalledOnce();
    expect(pool).not.toHaveBeenCalled();
    await expect(lifecycle.close()).rejects.toBeInstanceOf(AggregateError);
    expect(second).toHaveBeenCalledOnce();
  });

  it('starts all independent drains while one remains unresolved and never closes the pool', async () => {
    const lifecycle = new Lifecycle();
    const pool = vi.fn();
    const second = vi.fn();
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    lifecycle.defer(pool, { requiresCriticalSuccess: true });
    lifecycle.defer(() => drainAll([() => pending, second]), { critical: true });
    const closing = lifecycle.close();
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(pool).not.toHaveBeenCalled();
    finish();
    await closing;
    expect(pool).toHaveBeenCalledOnce();
  });

  it('does not gate the pool for noncritical failure and retains sticky critical failures', async () => {
    const lifecycle = new Lifecycle();
    const pool = vi.fn();
    const failure = new Error('critical');
    lifecycle.defer(pool, { requiresCriticalSuccess: true });
    lifecycle.defer(() => {}, { critical: true });
    lifecycle.defer(() => { throw failure; }, { critical: true });
    await expect(lifecycle.close()).rejects.toMatchObject({ errors: [failure] });
    expect(pool).not.toHaveBeenCalled();

    const other = new Lifecycle();
    const otherPool = vi.fn();
    other.defer(otherPool, { requiresCriticalSuccess: true });
    other.defer(() => { throw failure; });
    await expect(other.close()).rejects.toBeInstanceOf(AggregateError);
    expect(otherPool).toHaveBeenCalledOnce();
  });

  it('gates partial startup cleanup and preserves the original startup error', async () => {
    const lifecycle = new Lifecycle();
    const startupError = new Error('start failed');
    const stopError = new Error('stop failed');
    const pool = vi.fn();
    const report = vi.fn();
    lifecycle.defer(pool, { requiresCriticalSuccess: true });
    await expect(startWithCleanup(async () => {
      lifecycle.defer(() => { throw stopError; }, { critical: true });
      throw startupError;
    }, () => lifecycle.close(), report)).rejects.toBe(startupError);
    expect(pool).not.toHaveBeenCalled();
    expect((report.mock.calls[0]![0] as AggregateError).errors).toEqual([stopError]);
  });
});

describe('startup lifecycle', () => {
  it.each(['adapter', 'listen'])('cleans acquired resources after %s fails', async failure => {
    const calls: string[] = [];
    const lifecycle = new Lifecycle();
    const startupError = new Error(failure);
    lifecycle.defer(() => { calls.push('pool'); });
    lifecycle.defer(() => { calls.push('adapter'); });
    await expect(startWithCleanup(async () => {
      calls.push('adapter.start');
      if (failure === 'adapter') throw startupError;
      lifecycle.defer(() => { calls.push('timer'); });
      calls.push('listen');
      throw startupError;
    }, () => lifecycle.close(), vi.fn())).rejects.toBe(startupError);
    expect(calls).toEqual(failure === 'adapter'
      ? ['adapter.start', 'adapter', 'pool']
      : ['adapter.start', 'listen', 'timer', 'adapter', 'pool']);
  });

  it('attempts all cleanup, reports failures and preserves startup error', async () => {
    const lifecycle = new Lifecycle();
    const startupError = new Error('listen');
    const cleanupError = new Error('adapter close');
    const poolClose = vi.fn();
    const report = vi.fn();
    lifecycle.defer(poolClose);
    lifecycle.defer(() => { throw cleanupError; });
    await expect(startWithCleanup(async () => { throw startupError; }, () => lifecycle.close(), report)).rejects.toBe(startupError);
    expect(poolClose).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledOnce();
    expect((report.mock.calls[0]![0] as AggregateError).errors).toEqual([cleanupError]);
  });

  it('shares one close operation and does not close after successful startup', async () => {
    const lifecycle = new Lifecycle();
    const close = vi.fn();
    lifecycle.defer(close);
    await startWithCleanup(async () => {}, () => lifecycle.close(), vi.fn());
    expect(close).not.toHaveBeenCalled();
    await Promise.all([lifecycle.close(), lifecycle.close()]);
    expect(close).toHaveBeenCalledOnce();
    expect(() => lifecycle.defer(close)).toThrow('lifecycle already closing');
  });
});
