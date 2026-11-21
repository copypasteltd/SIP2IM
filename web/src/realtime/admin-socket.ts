import type { QueryClient } from '@tanstack/react-query';
import { useLoginSteps, type Platform } from './login-steps';

export type ConnectionState = 'connecting' | 'connected' | 'disconnected';
const eventKeys: Record<string, string[][]> = {
  'device.updated': [['devices'], ['dashboard']], 'device.online': [['devices'], ['dashboard']], 'device.offline': [['devices'], ['dashboard']],
  'sms.new': [['sms']], 'sms.task.updated': [['sms']], 'call.updated': [['calls'], ['dashboard']],
  'channel.updated': [['channels'], ['dashboard'], ['health']], 'channel.login.step': [['channels']], 'pairing.updated': [['channels']],
  'alert.raised': [['alerts'], ['dashboard']], 'alert.resolved': [['alerts'], ['dashboard']], 'settings.updated': [['settings']],
};
export function syncEvent(client: QueryClient, type: string) {
  if (!Object.hasOwn(eventKeys, type)) return;
  for (const queryKey of eventKeys[type]) void client.invalidateQueries({ queryKey });
}

export function startAdminSocket(token: string, client: QueryClient, onState: (state: ConnectionState) => void, ownsSession = () => true) {
  let socket: WebSocket | undefined;
  let stopped = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;
  const active = () => !stopped && ownsSession();

  function schedule() {
    if (!active()) return;
    useLoginSteps.getState().interrupted();
    onState('disconnected');
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempts++, 5));
    retry = setTimeout(connect, delay);
  }

  function connect() {
    if (!active()) return;
    onState('connecting');
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
    socket = current;
    const owns = () => active() && socket === current;
    let lastPong = 0;
    let authenticated = false;
    const accountStates: Partial<Record<Platform, string>> = {};

    function send(payload: object) {
      try { current.send(JSON.stringify(payload)); } catch { current.close(); }
    }
    current.onopen = () => {
      if (!owns()) return;
      send({ type: 'auth', token });
      if (!owns()) return;
      lastPong = Date.now();
      send({ type: 'ping' });
      if (!owns()) return;
      heartbeat = setInterval(() => {
        if (!owns() || current.readyState !== WebSocket.OPEN) return;
        if (Date.now() - lastPong > 60_000) current.close();
        else send({ type: 'ping' });
      }, 25_000);
    };
    current.onmessage = event => {
      if (!owns() || typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as { type?: unknown; data?: unknown } | null;
        if (!message || typeof message.type !== 'string') return;
        if (message.type === 'pong') {
          lastPong = Date.now();
          authenticated = true;
          if (attempts > 0) void client.invalidateQueries();
          attempts = 0;
          onState('connected');
          return;
        }
        if (!authenticated) return;
        if (message.data && typeof message.data === 'object') {
          const data = message.data as Record<string, unknown>;
          if (data.platform === 'qq' || data.platform === 'telegram') {
            const platform = data.platform;
            if (message.type === 'channel.login.step' &&
                (data.step === 'qr' || data.step === 'phone' || data.step === 'code' || data.step === 'password') &&
                (data.qrPngBase64 === null || typeof data.qrPngBase64 === 'string') &&
                (data.hint === null || typeof data.hint === 'string')) {
              useLoginSteps.getState().observeStep(platform, { step: data.step, qrPngBase64: data.qrPngBase64, hint: data.hint });
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
        syncEvent(client, message.type);
      } catch { /* Ignore malformed unsolicited events. */ }
    };
    current.onerror = () => { if (owns()) current.close(); };
    current.onclose = () => {
      if (!owns()) return;
      socket = undefined;
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
      schedule();
    };
  }

  connect();
  return () => {
    const owner = ownsSession();
    stopped = true;
    if (retry) clearTimeout(retry);
    if (heartbeat) clearInterval(heartbeat);
    if (socket) {
      socket.onopen = socket.onmessage = socket.onerror = socket.onclose = null;
      socket.close();
    }
    if (owner) {
      useLoginSteps.getState().interrupted();
      onState('disconnected');
    }
  };
}
