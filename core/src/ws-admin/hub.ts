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

  publish(type: string, data: unknown, isCurrent?: () => boolean): Promise<void> {
    return this.publishLatest(type, () => data, isCurrent);
  }

  publishLatest(type: string, load: () => unknown | Promise<unknown>, isCurrent: () => boolean = () => true): Promise<void> {
    if (!this.accepting || this.sockets.size === 0) return Promise.resolve();
    const current = () => this.accepting && isCurrent();
    const work = Promise.resolve().then(async () => {
      if (!current()) return;
      const data = await load();
      if (data !== null && current()) await this.broadcast(type, data, current);
    }).finally(() => this.pending.delete(work));
    this.pending.add(work);
    return work;
  }

  async stop(): Promise<void> {
    this.accepting = false;
    this.sockets.clear();
    await Promise.allSettled([...this.pending]);
  }

  private async broadcast(type: string, data: unknown, current: () => boolean): Promise<void> {
    const body = JSON.stringify({ type, ts: Date.now(), data });
    await Promise.all([...this.sockets].map(async ([socket, token]) => {
      if (!current()) return;
      let user: string | null;
      try { user = await this.authenticate(token); }
      catch { if (current()) this.disconnect(socket, token, 1011); return; }
      if (!current() || this.sockets.get(socket) !== token) return;
      if (!user) { this.disconnect(socket, token, 4403); return; }
      try { socket.send(body); } catch { this.disconnect(socket, token, 1011); }
    }));
  }
}
