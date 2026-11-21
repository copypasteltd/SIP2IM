import { createServer, type Server, type Socket } from 'node:net';
import { chmod, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { IPC_MAX_LENGTH } from '@voipgw/protocol';

export interface AdapterTransportSocket { write(data: Uint8Array): void; destroy(): void }
export interface AdapterTransportHandlers { data(bytes: Uint8Array): void; close(): void }
export interface AdapterIpcListenerOptions {
  path: string;
  onConnection(socket: AdapterTransportSocket): AdapterTransportHandlers;
}

/** Owns the Unix socket only; the attached manager owns framing and command correlation. */
export class AdapterIpcListener {
  private server: Server | undefined;
  private current: Socket | undefined;
  private ready = false;
  private starting: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  constructor(private readonly options: AdapterIpcListenerOptions) {}

  start(): Promise<void> {
    if (this.server || this.starting || this.closing) return Promise.reject(new Error('listener already started or closing'));
    const starting = this.startImpl();
    this.starting = starting;
    void starting.then(() => { if (this.starting === starting) this.starting = undefined; },
      () => { if (this.starting === starting) this.starting = undefined; });
    return starting;
  }

  private async startImpl(): Promise<void> {
    if (process.platform === 'win32') throw new Error('Unix socket permissions are unavailable on Windows');
    if (!isAbsolute(this.options.path)) throw new Error('socket path must be absolute');
    // A private parent protects the bind/chmod interval and prevents path substitution.
    const directory = await lstat(dirname(this.options.path));
    if (!directory.isDirectory() || (directory.mode & 0o077) !== 0 || directory.uid !== process.getuid?.()) {
      throw new Error('socket parent must be a private directory owned by this process');
    }
    const server = createServer({ pauseOnConnect: true }, socket => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.options.path, () => { server.off('error', reject); resolve(); });
      });
      await chmod(this.options.path, 0o600);
      const socketFile = await lstat(this.options.path);
      if (!socketFile.isSocket() || (socketFile.mode & 0o777) !== 0o600) throw new Error('socket permissions could not be secured');
      this.ready = true;
      server.on('error', () => { this.ready = false; this.current?.destroy(); });
    } catch (error) {
      this.ready = false;
      if (server.listening) {
        try { await new Promise<void>((resolve, reject) => server.close(closeError => closeError ? reject(closeError) : resolve())); }
        catch (closeError) { throw new AggregateError([error, closeError], 'listener startup failed; server cleanup outcome unknown'); }
      }
      this.server = undefined;
      throw error;
    }
  }

  private accept(socket: Socket): void {
    if (!this.ready) { socket.destroy(); return; }
    this.current?.destroy();
    this.current = socket;
    let closed = false;
    socket.on('error', () => socket.destroy());
    const transport: AdapterTransportSocket = {
      write: bytes => {
        if (closed || socket.destroyed || this.current !== socket) throw new Error('adapter disconnected');
        if (bytes.length > IPC_MAX_LENGTH + 4 || socket.writableLength + bytes.length > IPC_MAX_LENGTH + 4) {
          socket.destroy();
          throw new Error('adapter output limit exceeded');
        }
        socket.write(bytes);
      },
      destroy: () => socket.destroy(),
    };
    let handlers: AdapterTransportHandlers;
    try { handlers = this.options.onConnection(transport); } catch { socket.destroy(); return; }
    socket.on('close', () => {
      if (closed) return;
      closed = true;
      if (this.current === socket) this.current = undefined;
      try { handlers.close(); } catch { /* isolate consumer failures */ }
    });
    socket.on('data', chunk => {
      if (this.current !== socket || socket.destroyed) return;
      try { handlers.data(chunk); } catch { socket.destroy(); }
    });
    socket.resume();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.closeImpl();
    this.closing = closing;
    void closing.then(() => { if (this.closing === closing) this.closing = undefined; },
      () => { if (this.closing === closing) this.closing = undefined; });
    return closing;
  }

  private async closeImpl(): Promise<void> {
    if (this.starting) {
      try { await this.starting; } catch { /* startup cleaned up its own server */ }
    }
    this.ready = false;
    this.current?.destroy();
    const server = this.server;
    if (!server) return;
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    if (this.server === server) this.server = undefined;
  }
}
