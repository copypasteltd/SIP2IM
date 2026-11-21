import type { QueryClient } from '@tanstack/react-query';
import { parseLoginStep, useLoginSteps, type Platform } from './login-steps';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
const eventKeys: Record<string, string[][]> = {
  'device.updated': [['devices'], ['dashboard']], 'device.online': [['devices'], ['dashboard']], 'device.offline': [['devices'], ['dashboard']],
  'sms.new': [['sms']], 'sms.task.updated': [['sms']], 'call.updated': [['calls'], ['dashboard']],
  'channel.updated': [['channels'], ['dashboard'], ['health']], 'channel.login.step': [['channels']], 'pairing.updated': [['channels']],
  'alert.raised': [['alerts'], ['dashboard']], 'alert.resolved': [['alerts'], ['dashboard']], 'settings.updated': [['settings']],
};
function refresh(client: QueryClient, queryKey?: string[]) {
  try {
    void (queryKey ? client.invalidateQueries({ queryKey }) : client.invalidateQueries()).catch(() => {});
  } catch { /* A readback failure does not change transport readiness. */ }
}
export function syncEvent(client: QueryClient, type: string) {
  if (!Object.hasOwn(eventKeys, type)) return;
  for (const queryKey of eventKeys[type]) refresh(client, queryKey);
}

const OPEN_TIMEOUT_MS = 10_000;
const FIRST_PONG_TIMEOUT_MS = 10_000;
const PING_INTERVAL_MS = 25_000;
const PONG_FRESHNESS_MS = 60_000;

export function startAdminSocket(token: string, client: QueryClient, onState: (state: ConnectionState) => void, ownsSession = () => true) {
  let disposeSocket: ((close: boolean) => void) | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  const active = () => !stopped && ownsSession();

  function schedule() {
    if (!active() || retry !== undefined) return;
    useLoginSteps.getState().interrupted();
    if (!active()) return;
    onState('disconnected');
    if (!active()) return;
    const delay = Math.min(30_000, 1000 * 2 ** attempts);
    attempts = Math.min(attempts + 1, 5);
    retry = setTimeout(() => { retry = undefined; connect(); }, delay);
  }

  function connect() {
    if (!active()) return;
    onState('connecting');
    if (!active()) return;
    let current: WebSocket;
    try {
      const configured = import.meta.env.VITE_API_BASE as string | undefined;
      const base = new URL(configured || window.location.origin, window.location.origin);
      base.protocol = base.protocol === 'https:' ? 'wss:' : 'ws:';
      base.pathname = base.pathname.replace(/\/$/, '') + '/ws/admin';
      base.search = '';
      base.hash = '';
      current = new WebSocket(base.toString());
    } catch { schedule(); return; }
    let phase: 'opening' | 'awaiting-pong' | 'ready' = 'opening';
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let deadline: { at: number; timer?: ReturnType<typeof setTimeout> } | undefined;
    let pendingPong = false;
    const accountStates: Partial<Record<Platform, string>> = {};
    disposeSocket = dispose;
    const owns = () => active() && disposeSocket === dispose;

    function clearDeadline() {
      if (deadline?.timer !== undefined) clearTimeout(deadline.timer);
      deadline = undefined;
    }

    function dispose(close: boolean) {
      if (disposeSocket !== dispose) return;
      // Revoke ownership before touching the transport. A close event is not required.
      disposeSocket = undefined;
      clearDeadline();
      if (heartbeat !== undefined) clearInterval(heartbeat);
      current.onopen = current.onmessage = current.onerror = current.onclose = null;
      if (close) {
        try { current.close(); } catch { /* The attempt is already retired locally. */ }
      }
    }

    function retire(close = true) {
      if (disposeSocket !== dispose) return;
      dispose(close);
      schedule();
    }

    function armDeadline(ms: number) {
      clearDeadline();
      const budget: NonNullable<typeof deadline> = { at: performance.now() + ms };
      deadline = budget;
      const check = () => {
        if (deadline !== budget || disposeSocket !== dispose) return;
        if (!active()) { dispose(true); return; }
        const remaining = budget.at - performance.now();
        if (remaining <= 0) retire();
        else budget.timer = setTimeout(check, Math.ceil(remaining));
      };
      budget.timer = setTimeout(check, ms);
    }

    function withinDeadline() {
      if (!owns() || !deadline) return false;
      if (performance.now() < deadline.at) return true;
      // Browser throttling can defer the watchdog beyond this callback.
      retire();
      return false;
    }

    function isOpen() {
      if (!withinDeadline()) return false;
      if (current.readyState === WebSocket.OPEN) return true;
      retire();
      return false;
    }

    function send(payload: object) {
      if (!isOpen()) return false;
      try { current.send(JSON.stringify(payload)); return true; }
      catch { retire(); return false; }
    }

    function ping() {
      if (!isOpen() || pendingPong) return;
      pendingPong = true;
      send({ type: 'ping' });
    }

    armDeadline(OPEN_TIMEOUT_MS);
    current.onopen = () => {
      if (phase !== 'opening' || !withinDeadline()) return;
      phase = 'awaiting-pong';
      armDeadline(FIRST_PONG_TIMEOUT_MS);
      if (send({ type: 'auth', token })) ping();
    };
    current.onmessage = event => {
      if (phase === 'opening' || !isOpen() || typeof event.data !== 'string') return;
      let message: { type?: unknown; data?: unknown } | null;
      try { message = JSON.parse(event.data) as typeof message; }
      catch { return; }
      if (!message || typeof message.type !== 'string' || !withinDeadline()) return;
      if (message.type === 'pong') {
        if (!pendingPong) return;
        pendingPong = false;
        armDeadline(PONG_FRESHNESS_MS);
        if (phase === 'awaiting-pong') {
          phase = 'ready';
          const recovering = attempts > 0;
          attempts = 0;
          heartbeat = setInterval(ping, PING_INTERVAL_MS);
          if (owns()) onState('connected');
          if (recovering && owns()) refresh(client);
        }
        return;
      }
      if (phase !== 'ready') return;
      if (message.data && typeof message.data === 'object') {
        const data = message.data as Record<string, unknown>;
        if (data.platform === 'qq' || data.platform === 'telegram') {
          const platform = data.platform;
          if (message.type === 'channel.login.step') {
            const step = parseLoginStep(data);
            if (step) useLoginSteps.getState().observeStep(platform, step);
          }
          if (message.type === 'channel.updated' && typeof data.state === 'string') {
            const previous = accountStates[platform];
            accountStates[platform] = data.state;
            if (data.state === 'logged_in') useLoginSteps.getState().finished(platform);
            else if (data.state === 'offline' || data.state === 'banned' || data.state === 'error' ||
                (data.state === 'logged_out' && previous !== undefined && previous !== data.state)) useLoginSteps.getState().interrupted(platform);
          }
        }
      }
      if (owns()) syncEvent(client, message.type);
    };
    current.onerror = () => retire();
    current.onclose = () => retire(false);
  }

  connect();
  return () => {
    if (stopped) return;
    stopped = true;
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
    disposeSocket?.(true);
    if (ownsSession()) {
      useLoginSteps.getState().interrupted();
      if (ownsSession()) onState('disconnected');
    }
  };
}
