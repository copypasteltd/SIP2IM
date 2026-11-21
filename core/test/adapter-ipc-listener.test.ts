import { EventEmitter } from 'node:events';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { IPC_MAX_LENGTH } from '@voipgw/protocol';
import { AdapterIpcListener, type AdapterTransportSocket } from '../src/adapters/ipc-listener.js';

class FakeSocket extends EventEmitter {
  destroyed = false;
  writableLength = 0;
  writes: Uint8Array[] = [];
  write(data: Uint8Array) { this.writes.push(data); return true; }
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('close'); } return this; }
  resume() { return this; }
}
function setup() {
  const sockets: AdapterTransportSocket[] = [];
  const data = vi.fn(), close = vi.fn();
  const listener = new AdapterIpcListener({path:'/unused/test.sock', onConnection: socket => { sockets.push(socket); return {data,close}; }});
  const internal = listener as unknown as { ready: boolean; accept(socket: FakeSocket): void };
  internal.ready = true;
  return {listener, internal, sockets, data, close};
}
describe('adapter IPC transport', () => {
  it('rejects a second start and waits for pending startup before closing', async () => {
    const listener = new AdapterIpcListener({path:'/unused/test.sock', onConnection: () => ({data() {}, close() {}})});
    const internal = listener as unknown as { startImpl(): Promise<void>; server?: {close(cb: (error?: Error) => void): void} };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const closeServer = vi.fn((cb: (error?: Error) => void) => cb());
    vi.spyOn(internal, 'startImpl').mockImplementation(async () => { await gate; internal.server = { close: closeServer }; });
    const start = listener.start();
    await expect(listener.start()).rejects.toThrow('already started');
    const close = listener.close();
    const closeAgain = listener.close();
    expect(closeAgain).toBe(close);
    expect(closeServer).not.toHaveBeenCalled();
    await expect(listener.start()).rejects.toThrow('closing');
    release();
    await Promise.all([start, close]);
    expect(closeServer).toHaveBeenCalledOnce();
    expect(internal.server).toBeUndefined();
  });
  it('propagates server close callback errors and keeps the server reference', async () => {
    const {listener}=setup(); const failure=new Error('server close failed');
    const internal=listener as unknown as {server?: {close(cb:(error?:Error)=>void):void}};
    const server={close:vi.fn((cb:(error?:Error)=>void)=>cb(failure))}; internal.server=server;
    await expect(listener.close()).rejects.toBe(failure); expect(internal.server).toBe(server);
  });
  it('completes close when pending startup fails and permits another start', async () => {
    const listener = new AdapterIpcListener({path:'/unused/test.sock', onConnection: () => ({data() {}, close() {}})});
    const internal = listener as unknown as { startImpl(): Promise<void> };
    let reject!: (error: Error) => void;
    const gate = new Promise<void>((_resolve, fail) => { reject = fail; });
    const startImpl = vi.spyOn(internal, 'startImpl').mockReturnValueOnce(gate).mockResolvedValueOnce();
    const start = listener.start();
    const failure = expect(start).rejects.toThrow('bind failed');
    const close = listener.close();
    reject(new Error('bind failed'));
    await Promise.all([failure, close]);
    await listener.start();
    expect(startImpl).toHaveBeenCalledTimes(2);
  });
  it.skipIf(process.platform === 'win32')('binds a socket with mode 0600 in a private directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'voip-ipc-'));
    const path = join(dir, 'adapter.sock');
    const listener = new AdapterIpcListener({path, onConnection: () => ({data() {}, close() {}})});
    try {
      await listener.start();
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    } finally {
      await listener.close();
      await rm(dir, {recursive:true, force:true});
    }
  });
  it('replaces the previous client and rejects writes from it', () => {
    const {internal,sockets,data,close} = setup();
    const first = new FakeSocket(), second = new FakeSocket();
    internal.accept(first);
    first.emit('data', Buffer.from([1,2]));
    expect(data).toHaveBeenCalledOnce();
    internal.accept(second);
    expect(first.destroyed).toBe(true);
    expect(close).toHaveBeenCalledOnce();
    expect(() => sockets[0]!.write(new Uint8Array([1]))).toThrow();
    sockets[1]!.write(new Uint8Array([3]));
    expect(second.writes).toEqual([new Uint8Array([3])]);
    first.emit('data', Buffer.from([9]));
    expect(data).toHaveBeenCalledOnce();
  });
  it('destroys an overflowing peer rather than silently dropping output', () => {
    const {internal,sockets} = setup();
    const socket = new FakeSocket(); internal.accept(socket);
    socket.writableLength = IPC_MAX_LENGTH;
    expect(() => sockets[0]!.write(new Uint8Array(5))).toThrow('output limit');
    expect(socket.destroyed).toBe(true);
  });
  it('fails closed where Unix socket permission enforcement is unavailable', async () => {
    if (process.platform !== 'win32') return;
    const {listener} = setup();
    await expect(listener.start()).rejects.toThrow('permissions are unavailable');
  });
});
