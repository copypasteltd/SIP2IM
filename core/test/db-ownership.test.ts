import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { acquireCoreOwnership, CORE_OWNERSHIP_LOCK_KEY, type OwnershipClient } from '../src/db/ownership.js';
import type { Config } from '../src/config/load.js';

const config = {} as Config['database'];
class FakeClient extends EventEmitter {
  connect = vi.fn(async () => {});
  query = vi.fn(async (_sql: string, _values: number[]) => ({ rows: [{ acquired: true }] }));
  end = vi.fn(async () => {});
}
const acquire = (client: FakeClient, onLost = vi.fn()) =>
  acquireCoreOwnership(config, onLost, () => client as OwnershipClient);

describe('Core database ownership', () => {
  it('holds one dedicated session until idempotent close without issuing unlock', async () => {
    const client = new FakeClient(); const onLost = vi.fn();
    const guard = await acquire(client, onLost);
    guard.assertHeld();
    expect(client.query).toHaveBeenCalledExactlyOnceWith('SELECT pg_try_advisory_lock($1) AS acquired', [CORE_OWNERSHIP_LOCK_KEY]);
    const first = guard.close(); const second = guard.close();
    expect(first).toBe(second);
    expect(() => guard.assertHeld()).toThrow();
    await first;
    expect(client.end).toHaveBeenCalledOnce();
    client.emit('end');
    expect(onLost).not.toHaveBeenCalled();
  });
  it('stops admitting work when the pinned session no longer proves ownership', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      const onLost = vi.fn();
      const guard = await acquireCoreOwnership(config, onLost, () => client as OwnershipClient, 100, 20);
      client.query.mockResolvedValueOnce({ rows: [{ acquired: false }] });
      await vi.advanceTimersByTimeAsync(20);
      expect(client.query.mock.calls[1]?.[0]).toContain('pid=pg_backend_pid()');
      expect(onLost).toHaveBeenCalledOnce();
      expect(() => guard.assertHeld()).toThrow('ownership no longer held');
      await guard.close();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(client.query).toHaveBeenCalledTimes(2);
    } finally { vi.useRealTimers(); }
  });

  it('rejects contention and malformed results and closes the session', async () => {
    for (const rows of [[{ acquired: false }], []]) {
      const client = new FakeClient(); client.query.mockResolvedValueOnce({ rows });
      await expect(acquire(client)).rejects.toThrow('ownership lock is unavailable');
      expect(client.end).toHaveBeenCalledOnce();
    }
  });
  it('closes a session after connection or acquisition errors', async () => {
    for (const failure of ['connect', 'query'] as const) {
      const client = new FakeClient(); const error = new Error(failure);
      client[failure].mockRejectedValueOnce(error);
      await expect(acquire(client)).rejects.toBe(error);
      expect(client.end).toHaveBeenCalledOnce();
    }
  });
  it('fails acquisition if the session is lost before a successful reply', async () => {
    const client = new FakeClient(); const onLost = vi.fn(); const error = new Error('lost');
    client.query.mockImplementationOnce(async () => { client.emit('error', error); return { rows: [{ acquired: true }] }; });
    await expect(acquire(client, onLost)).rejects.toBe(error);
    expect(onLost).not.toHaveBeenCalled(); expect(client.end).toHaveBeenCalledOnce();
  });
  it.each(['connect', 'query'] as const)('rejects when loss occurs during pending %s', async stage => {
    const client = new FakeClient(); const error = new Error('connection lost');
    if (stage === 'connect') client.connect.mockImplementationOnce(() => new Promise(() => {}));
    else client.query.mockImplementationOnce(() => new Promise(() => {}));
    const pending = acquire(client);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    client.emit('error', error);
    await expect(pending).rejects.toBe(error);
    expect(client.end).toHaveBeenCalledOnce();
  });
  it('bounds stalled startup and reports uncertain session cleanup', async () => {
    vi.useFakeTimers();
    try {
      const client = new FakeClient();
      client.connect.mockImplementationOnce(() => new Promise(() => {}));
      client.end.mockImplementationOnce(() => new Promise(() => {}));
      const pending = acquireCoreOwnership(config, vi.fn(), () => client as OwnershipClient, 10);
      const outcome = expect(pending).rejects.toThrow('session cleanup is uncertain');
      await vi.advanceTimersByTimeAsync(20);
      await outcome;
      expect(client.query).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(['error', 'end'] as const)('invalidates synchronously and notifies once on %s', async event => {
    const client = new FakeClient(); const onLost = vi.fn(); const guard = await acquire(client, onLost);
    if (event === 'error') client.emit('error', new Error('lost')); else client.emit('end');
    expect(onLost).toHaveBeenCalledOnce();
    expect(() => guard.assertHeld()).toThrow();
    client.emit('error', new Error('again')); client.emit('end');
    expect(onLost).toHaveBeenCalledOnce();
    await guard.close();
  });
});
