import type { DeviceSocket } from '../ws-device/session.js';
export class AdminHub {
  private readonly sockets = new Map<DeviceSocket, string>();
  private readonly pending = new Set<Promise<void>>();
  private accepting = true;

  constructor(private readonly authenticate: (token: string) => Promise<string | null>) {}

  add(socket: DeviceSocket, token: string): void { if (this.accepting) this.sockets.set(socket, token); }
  remove(socket: DeviceSocket): void { this.sockets.delete(socket); }

  private disconnect(socket: DeviceSocket, token: string, code: number): void {
    if (this.sockets.get(socket) !== token) return;
    this.remove(socket);
    try { socket.close(code); } catch { /* A failed subscriber cannot interrupt other broadcasts. */ }
  }

  publish(type: string, data: unknown): Promise<void> {
    return this.publishLatest(type, () => data);
  }

  publishLatest(type: string, load: () => unknown | Promise<unknown>): Promise<void> {
    if (!this.accepting || this.sockets.size === 0) return Promise.resolve();
    const work = Promise.resolve().then(async () => {
      if (!this.accepting) return;
      const data = await load();
      if (data !== null && this.accepting) await this.broadcast(type, data);
    }).finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.sockets.clear();
    await Promise.allSettled([...this.pending]);
  }

  private async broadcast(type: string, data: unknown): Promise<void> {
    const body = JSON.stringify({ type, ts: Date.now(), data });
    await Promise.all([...this.sockets].map(async ([socket, token]) => {
      try {
        if (!await this.authenticate(token)) {
          this.disconnect(socket, token, 4403);
          return;
        }
        if (this.sockets.get(socket) === token) socket.send(body);
      } catch {
        this.disconnect(socket, token, 1011);
      }
    }));
  }
}
