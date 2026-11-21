import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_PORT, HOST, MAX_BODY, RequestError, fault, makeDemoApi } from './api.mjs';
import { attachAdminSockets, localWebSocketServer } from './realtime.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const noticePath = '/__voip-demo/banner.css';
const notice = '<aside id="voip-demo-banner" aria-label="Synthetic demo / 合成演示">' +
  '<strong>Synthetic demo / 合成演示</strong>' +
  '<span>Simulated records only. No real SMS, calls, or devices. · 仅模拟记录。无真实短信、通话或设备。</span>' +
  '<span class="demo-sign-in">Public demo sign-in · 演示登录 <b>demo / demo</b></span></aside>';
const knownPage = /^\/(?:login|dashboard|devices(?:\/[^/]+)?|sms(?:\/[^/]+)?|calls(?:\/[^/]+)?|channels|commands(?:\/.*)?|alerts(?:\/.*)?|settings|audit(?:\/.*)?)?\/?$/;
const assetPath = /^\/assets\/[A-Za-z0-9_.-]+$/;
const contentTypes = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.woff': 'font/woff',
};

class DemoStartError extends Error {}

function checkedPort(value) {
  if (!/^[0-9]{1,5}$/.test(String(value)) || Number(value) < 1024 || Number(value) > 65535) {
    throw new DemoStartError('Demo port must be an integer from 1024 to 65535.');
  }
  return Number(value);
}

export function parsePort(args) {
  if (args.length === 0) return DEFAULT_PORT;
  if (args.length === 2 && args[0] === '--port') return checkedPort(args[1]);
  throw new DemoStartError('Usage: node tools/demo/server.mjs [--port 41730]');
}

function inside(parent, target) {
  const subpath = relative(parent, target);
  return subpath !== '' && subpath !== '..' && !subpath.startsWith('..' + sep) && !isAbsolute(subpath);
}

async function readDistFile(dist, path) {
  let physical;
  try { physical = await realpath(join(dist, path)); }
  catch (cause) {
    if (cause.code === 'ENOENT' || cause.code === 'ENOTDIR') return null;
    throw cause;
  }
  if (!inside(dist, physical)) return null;
  const meta = await stat(physical);
  if (!meta.isFile() || meta.size > 16 * 1024 * 1024) return null;
  return readFile(physical);
}

export function decorateIndex(html) {
  const head = /<\/head\s*>/i;
  const body = /<body(?:\s[^>]*)?>/i;
  if (!/<div\b[^>]*\bid=["']root["']/i.test(html) || !head.test(html) || !body.test(html)) {
    throw new DemoStartError('The built Web index is missing its React entry. Rebuild the Web workspace.');
  }
  return html.replace(head, match => '<link rel="stylesheet" href="' + noticePath + '">' + match)
    .replace(body, match => match + notice);
}

async function loadWeb() {
  const root = await realpath(repoRoot);
  const dist = join(root, 'web', 'dist');
  let index;
  try {
    if (relative(dist, await realpath(dist)) !== '') throw new DemoStartError('The Web dist directory must be local to this checkout.');
    index = await readDistFile(dist, 'index.html');
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  if (!index) throw new DemoStartError('Missing web/dist/index.html. Build from the repository root with npm run build --workspace @voipgw/web.');
  const html = index.toString('utf8');
  const entry = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'](\/assets\/[A-Za-z0-9_.-]+\.js)["']/i.exec(html)?.[1];
  if (!entry || !await readDistFile(dist, entry.slice(1))) throw new DemoStartError('The built Web module is missing. Rebuild the Web workspace.');
  return { root, dist, html: decorateIndex(html), css: await readFile(join(root, 'tools/demo/banner.css')) };
}

export function isLocalRequest(req, port) {
  const { host, origin, 'sec-fetch-site': site } = req.headers;
  const authority = HOST + ':' + port;
  return req.socket.remoteAddress === HOST && host === authority &&
    (origin === undefined || origin === 'http://' + authority) &&
    (site === undefined || site === 'same-origin' || site === 'none');
}

function parseUrl(value, origin) {
  if (typeof value !== 'string' || value.length > 8192 || !value.startsWith('/') || value.startsWith('//') || /[\\#\x00-\x20]/.test(value)) {
    throw new RequestError(400, 'BAD_REQUEST');
  }
  const url = new URL(value, origin);
  if (url.origin !== origin) throw new RequestError(400, 'BAD_REQUEST');
  return url;
}

export async function readJson(req) {
  const length = req.headers['content-length'];
  if (length !== undefined && Number(length) > MAX_BODY) throw new RequestError(413, 'BODY_TOO_LARGE');
  if (req.headers['content-encoding'] !== undefined && req.headers['content-encoding'] !== 'identity') {
    throw new RequestError(415, 'BAD_REQUEST');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > MAX_BODY) throw new RequestError(413, 'BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  if (!bytes) return undefined;
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) {
    throw new RequestError(415, 'BAD_REQUEST');
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, bytes))); }
  catch { throw new RequestError(400, 'BAD_REQUEST'); }
}

export async function makeDemoServer({ port = DEFAULT_PORT, now = Date.now } = {}) {
  port = checkedPort(port);
  const { root, dist, html, css } = await loadWeb();
  const origin = 'http://' + HOST + ':' + port;
  const allow = req => isLocalRequest(req, port);
  const WebSocketServer = await localWebSocketServer(root);
  const api = makeDemoApi({ port, now, onEvent: event => realtime.publish(event) });
  const csp = "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; " +
    "form-action 'self'; script-src 'self'; style-src 'self'; style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; " +
    "font-src 'self' data:; media-src 'none'; worker-src 'none'; connect-src 'self' ws://" + HOST + ':' + port;

  async function handle(req, res) {
    const send = (status, type, body) => {
      if (res.destroyed) return;
      if (!req.readableEnded && (Number(req.headers['content-length']) > 0 || req.headers['transfer-encoding'])) {
        res.setHeader('Connection', 'close');
      }
      res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body) });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const json = (status, value) => send(status, 'application/json; charset=utf-8', JSON.stringify(value));
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'microphone=(), camera=(), geolocation=()');
    try {
      if (!allow(req)) throw new RequestError(403, 'DEMO_LOCAL_ONLY');
      const url = parseUrl(req.url, origin);
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        const result = await api.handle({ method: req.method, url, headers: req.headers, body: () => readJson(req) });
        json(200, result);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (url.pathname === noticePath) return send(200, contentTypes['.css'], css);
        if (assetPath.test(url.pathname)) {
          const extension = extname(url.pathname);
          const type = Object.hasOwn(contentTypes, extension) ? contentTypes[extension] : null;
          const asset = type ? await readDistFile(dist, url.pathname.slice(1)) : null;
          if (asset) return send(200, type, asset);
        }
        if (url.pathname === '/index.html' || knownPage.test(url.pathname)) return send(200, 'text/html; charset=utf-8', html);
      }
      throw new RequestError(404, 'NOT_FOUND');
    } catch (cause) {
      const safe = cause instanceof RequestError ? cause : new RequestError(500, 'INTERNAL');
      json(safe.status, fault(safe));
    }
  }

  const server = createServer({ requestTimeout: 10_000, headersTimeout: 6000, connectionsCheckingInterval: 1000, keepAliveTimeout: 4000 }, handle);
  server.maxConnections = 40;
  server.maxRequestsPerSocket = 160;
  const realtime = attachAdminSockets(server, WebSocketServer, allow, api.authenticate);
  server.once('close', () => realtime.close());
  return { server, origin, realtimeEnabled: realtime.enabled };
}

async function main(args) {
  const port = parsePort(args);
  const { server, origin, realtimeEnabled } = await makeDemoServer({ port });
  await new Promise((ready, reject) => {
    server.once('error', reject);
    server.listen({ host: HOST, port, exclusive: true }, () => {
      server.removeListener('error', reject);
      ready();
    });
  });
  console.log('VOIP synthetic demo / 合成演示 ' + origin + '/');
  console.log('Public demo sign-in / 演示登录 demo / demo');
  if (!realtimeEnabled) console.warn('The local ws package is unavailable. Web will show its disconnected/unknown statuses.');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(cause => {
    if (cause instanceof DemoStartError) console.error(cause.message);
    else if (cause.code === 'EADDRINUSE') console.error('Demo port in use. Choose another port with --port.');
    else console.error('Unable to start the local VOIP demo.');
    process.exitCode = 1;
  });
}
