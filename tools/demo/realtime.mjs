import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

const require = createRequire(import.meta.url);
const OPEN = 1;
const MAX_CLIENTS = 24;
const MAX_FRAME = 1024;

export async function localWebSocketServer(root) {
  const repo = await realpath(root);
  for (const workspace of ['core', '', 'web']) {
    try {
      const path = await realpath(join(repo, workspace, 'node_modules', 'ws'));
      const local = relative(repo, path);
      if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) continue;
      const { WebSocketServer } = require(path);
      if (typeof WebSocketServer === 'function') return WebSocketServer;
    } catch (cause) {
      if (cause.code !== 'ENOENT' && cause.code !== 'MODULE_NOT_FOUND') throw cause;
    }
  }
  return null;
}

export function wireAdminSocket(socket, authenticate) {
  let token;
  const timer = setTimeout(() => socket.close(4401), 5000);
  timer.unref();
  socket.once('close', () => { clearTimeout(timer); token = undefined; });
  socket.on('error', () => socket.terminate());
  const send = event => {
    if (socket.bufferedAmount > 4096) return socket.terminate();
    socket.send(event, error => { if (error) socket.terminate(); });
  };
  socket.on('message', (raw, binary) => {
    if (socket.readyState !== OPEN) return;
    if (binary || Buffer.byteLength(raw) > MAX_FRAME) return socket.close(1008);
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return socket.close(1008); }
    if (!token) {
      if (message?.type !== 'auth' || !authenticate(message.token)) return socket.close(4403);
      token = message.token;
      clearTimeout(timer);
      return;
    }
    if (!authenticate(token)) return socket.close(4403);
    if (message?.type === 'ping') send('{"type":"pong"}');
  });
  return event => {
    if (!token || socket.readyState !== OPEN) return;
    if (!authenticate(token)) return socket.close(4403);
    send(event);
  };
}

export function attachAdminSockets(server, WebSocketServer, allowed, authenticate) {
  const ws = WebSocketServer && new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME, perMessageDeflate: false });
  const subscribers = new Set();
  server.on('upgrade', (request, socket, head) => {
    if (!ws || request.url !== '/ws/admin' || !allowed(request) || subscribers.size >= MAX_CLIENTS) {
      socket.destroy();
      return;
    }
    ws.handleUpgrade(request, socket, head, connection => {
      const publish = wireAdminSocket(connection, authenticate);
      subscribers.add(publish);
      connection.once('close', () => subscribers.delete(publish));
    });
  });
  return {
    enabled: Boolean(ws),
    publish(event) {
      const payload = JSON.stringify(event);
      for (const send of subscribers) send(payload);
    },
    close() {
      for (const connection of ws?.clients ?? []) connection.terminate();
      ws?.close();
    },
  };
}
