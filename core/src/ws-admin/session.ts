import {adminAuth} from '@voipgw/protocol';
import type {DeviceSocket} from '../ws-device/session.js';

interface AdminState {
  socket: DeviceSocket;
  token?: string;
  authenticated: boolean;
  closed: boolean;
  pending: number;
  queue: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
  onAuthenticated: (token:string) => void;
  onClose: () => void;
}

/** Owns admin connections and all admitted message/authentication work. */
export class AdminSessions {
  private readonly sessions = new Set<AdminState>();
  private stopping = false;
  private cleanupFailed = false;
  private stopPromise?: Promise<void>;

  constructor(private readonly authenticate:(token:string)=>Promise<string|null>) {}

  private detach(state:AdminState):void {
    if (!state.closed) {
      state.closed = true;
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
      try { state.onClose(); } catch { this.cleanupFailed = true; }
      if (state.pending === 0) this.sessions.delete(state);
    }
  }

  private closeWith(state: AdminState, code: number): void {
    if (state.closed) return;
    this.detach(state);
    try { state.socket.close(code); } catch { this.cleanupFailed = true; }
  }

  revokeToken(token: string): void {
    for (const state of this.sessions) if (state.token === token) this.closeWith(state, 4403);
  }

  /** The product has one administrator. A confirmed password change revokes their sessions. */
  revokeAll(): void {
    for (const state of this.sessions) this.closeWith(state, 4403);
  }

  /** Closes admission synchronously and drains admitted work; requests socket closure,
   * but does not wait for the transport close event. The owner must await it separately. */
  stop():Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const states = [...this.sessions];
    for (const state of states) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    }
    // Defer cleanup so reentrant callers always observe the same promise.
    this.stopPromise = Promise.resolve().then(async () => {
      const results = await Promise.allSettled(states.map(state => state.queue));
      let failed = this.cleanupFailed || results.some(result => result.status === 'rejected');
      for (const state of states) {
        const wasClosed = state.closed;
        try { this.detach(state); } catch { failed = true; }
        if (!wasClosed) {
          try { state.socket.close(1001); } catch { failed = true; }
        }
      }
      // Never return callback errors, which could contain authentication secrets.
      if (failed || this.cleanupFailed) throw new Error('admin session shutdown failed');
    });
    return this.stopPromise;
  }

  open(socket:DeviceSocket,onAuthenticated:(token:string)=>void=()=>{},onClose:()=>void=()=>{}) {
    if (this.stopping) {
      try { socket.close(1001); } catch { this.cleanupFailed = true; }
      return {close:()=>{},message:(_raw:string):Promise<void>=>Promise.resolve()};
    }
    const state:AdminState = {socket,authenticated:false,closed:false,pending:0,queue:Promise.resolve(),timer:undefined,onAuthenticated,onClose};
    this.sessions.add(state);
    const closeWith = (code: number) => this.closeWith(state, code);
    state.timer = setTimeout(() => {
      if (!state.authenticated && !state.closed) closeWith(4401);
    },5000);
    return {
      close:()=>this.detach(state),
      message:(raw:string):Promise<void> => {
        if (this.stopping || state.closed) return Promise.resolve();
        if (state.pending >= 64) { closeWith(1013); return Promise.resolve(); }
        state.pending++;
        const job = state.queue.then(async () => {
          if (state.closed) return;
          try {
            const parsed:unknown = JSON.parse(raw);
            if (!state.authenticated) {
              const auth = adminAuth.safeParse(parsed);
              if (!auth.success) { closeWith(4403); return; }
              state.token = auth.data.token;
              const identity = await this.authenticate(state.token);
              if (state.closed) return;
              if (!identity) { closeWith(4403); return; }
              state.authenticated = true;
              if (state.timer !== undefined) clearTimeout(state.timer);
              state.timer = undefined;
              state.onAuthenticated(auth.data.token);
              return;
            }
            if ((parsed as {type?:unknown})?.type === 'ping') {
              const identity = state.token && await this.authenticate(state.token);
              if (state.closed) return;
              if (!identity) { closeWith(4403); return; }
              socket.send(JSON.stringify({ type: 'pong' }));
            }
          } catch {
            if (!state.closed) closeWith(1011);
          }
        });
        state.queue = job.finally(() => {
          state.pending--;
          if (state.closed && state.pending === 0) this.sessions.delete(state);
        });
        return state.queue;
      }
    };
  }
}

/** Compatibility wrapper for callers which do not need registry shutdown. */
export function openAdminSession(socket:DeviceSocket,authenticate:(token:string)=>Promise<string|null>,onAuthenticated:(token:string)=>void=()=>{},onClose:()=>void=()=>{}) {
  return new AdminSessions(authenticate).open(socket,onAuthenticated,onClose);
}
