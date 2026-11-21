import { describe, expect, it, vi } from 'vitest';
import { QuiescenceCoordinator } from '../src/quiescence.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

async function expectPending(promise: Promise<unknown>) {
  const outcome = await Promise.race([promise.then(() => 'settled'), new Promise<'pending'>(resolve => setImmediate(() => resolve('pending')))]);
  expect(outcome).toBe('pending');
}

describe('QuiescenceCoordinator', () => {
  it('closes admission synchronously and waits for every admitted lease', async () => {
    const coordinator = new QuiescenceCoordinator();
    const first = coordinator.admit()!;
    const second = coordinator.admit()!;
    const hookReached = deferred();
    coordinator.registerStop(() => { hookReached.resolve(); });
    const shutdown = coordinator.shutdown();
    expect(coordinator.admit()).toBeUndefined();
    expect(() => coordinator.registerStop(() => {})).toThrow('admission closed');
    expect(coordinator.shutdown()).toBe(shutdown);
    first.release(); first.release();
    await hookReached.promise;
    await expectPending(shutdown);
    second.release();
    expect(await shutdown).toEqual({ safe: true, errors: [] });
  });

  it('starts every stop hook and waits for hooks and leases independently', async () => {
    const coordinator = new QuiescenceCoordinator();
    const lease = coordinator.admit()!;
    const gate = deferred();
    const first = vi.fn(() => gate.promise);
    const second = vi.fn();
    coordinator.registerStop(first);
    coordinator.registerStop(second);
    const shutdown = coordinator.shutdown();
    await vi.waitFor(() => expect(second).toHaveBeenCalledOnce());
    expect(first).toHaveBeenCalledOnce();
    lease.release();
    await expectPending(shutdown);
    gate.resolve();
    expect(await shutdown).toEqual({ safe: true, errors: [] });
  });

  it('reports every stop failure as unsafe after all leases drain', async () => {
    const coordinator = new QuiescenceCoordinator();
    const lease = coordinator.admit()!;
    const one = new Error('one');
    const two = new Error('two');
    coordinator.registerStop(() => { throw one; });
    coordinator.registerStop(async () => { throw two; });
    const third = vi.fn();
    coordinator.registerStop(third);
    const shutdown = coordinator.shutdown();
    await vi.waitFor(() => expect(third).toHaveBeenCalledOnce());
    await expectPending(shutdown);
    lease.release();
    expect(await shutdown).toEqual({ safe: false, errors: [one, two] });
  });

  it('admits synchronously and releases after throws and asynchronous rejections', async () => {
    const coordinator = new QuiescenceCoordinator();
    const gate = deferred();
    const syncError = new Error('sync');
    const asyncError = new Error('async');
    const sync = coordinator.run(() => { throw syncError; })!;
    const asyncWork = coordinator.run(async () => { await gate.promise; throw asyncError; })!;
    const syncCheck = expect(sync).rejects.toBe(syncError);
    const asyncCheck = expect(asyncWork).rejects.toBe(asyncError);
    const shutdown = coordinator.shutdown();
    const notRun = vi.fn();
    expect(coordinator.run(notRun)).toBeUndefined();
    expect(notRun).not.toHaveBeenCalled();
    await syncCheck;
    await expectPending(shutdown);
    gate.resolve();
    await asyncCheck;
    expect(await shutdown).toEqual({ safe: true, errors: [] });
  });

  it.each(['direct', 'after await'])('rejects %s reentrant shutdown from a stop hook', async mode => {
    const coordinator = new QuiescenceCoordinator();
    const other = vi.fn();
    if (mode === 'direct') coordinator.registerStop(() => coordinator.shutdown());
    else coordinator.registerStop(async () => { await Promise.resolve(); await coordinator.shutdown(); });
    coordinator.registerStop(other);
    const result = await coordinator.shutdown();
    expect(other).toHaveBeenCalledOnce();
    expect(result.safe).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toEqual(new Error('stop hook cannot await its own shutdown'));
  });

  it('permits release before the drain starts', async () => {
    const coordinator = new QuiescenceCoordinator();
    const lease = coordinator.admit()!;
    const shutdown = coordinator.shutdown();
    lease.release();
    expect(await shutdown).toEqual({ safe: true, errors: [] });
  });
});
