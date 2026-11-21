import { afterEach, describe, expect, it, vi } from 'vitest';
import { Lifecycle } from '../src/lifecycle.js';
import { TrackedInterval } from '../src/tracked-interval.js';

afterEach(() => vi.useRealTimers());

describe('TrackedInterval', () => {
  it('skips repeated ticks only for the busy job, drains it and starts nothing after stop', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const busy = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const quick = vi.fn();
    const lifecycle = new Lifecycle();
    const downstream = vi.fn();
    lifecycle.defer(downstream);
    const interval = new TrackedInterval(10, [busy, quick], vi.fn());
    lifecycle.defer(() => interval.stop());
    await vi.advanceTimersByTimeAsync(100);
    expect(busy).toHaveBeenCalledOnce();
    expect(quick).toHaveBeenCalledTimes(10);
    release();
    await vi.advanceTimersByTimeAsync(10);
    expect(busy).toHaveBeenCalledTimes(2);
    expect(quick).toHaveBeenCalledTimes(11);
    const closing = lifecycle.close();
    await Promise.resolve();
    vi.advanceTimersByTime(100);
    expect(busy).toHaveBeenCalledTimes(2);
    expect(quick).toHaveBeenCalledTimes(11);
    expect(downstream).not.toHaveBeenCalled();
    release();
    await closing;
    expect(downstream).toHaveBeenCalledOnce();
    await interval.stop();
  });

  it('reports failures during shutdown and still drains other jobs', async () => {
    vi.useFakeTimers();
    const syncError = new Error('sync');
    const asyncError = new Error('async');
    let release!: () => void;
    let reject!: (error: unknown) => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const failing = new Promise<void>((_, r) => { reject = r; });
    const report = vi.fn();
    const interval = new TrackedInterval(10, [() => { throw syncError; }, () => failing, () => pending], report);
    await vi.advanceTimersByTimeAsync(10);
    const stopped = interval.stop();
    const rejection = expect(stopped).rejects.toMatchObject({errors: [asyncError]});
    reject(asyncError);
    await Promise.resolve();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(2);
    release();
    await rejection;
    expect(interval.stop()).toBe(stopped);
  });
  it('logs settled failures without poisoning later shutdown', async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    const interval = new TrackedInterval(10, [() => { throw new Error('transient'); }], report);
    await vi.advanceTimersByTimeAsync(30);
    expect(report).toHaveBeenCalledTimes(3);
    await expect(interval.stop()).resolves.toBeUndefined();
  });
});
