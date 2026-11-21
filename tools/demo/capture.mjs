import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../../', import.meta.url));
const origin = 'http://127.0.0.1:41730';
const width = 1440, height = 900, fps = 10;
const names = ['dashboard.png', 'alerts.png', 'bindings.png', 'sms.png', 'walkthrough.mp4', 'walkthrough.gif'];
const caption = 'Synthetic reply: picked up at the demo desk.';
const [chrome, outputArg = 'docs/media'] = process.argv.slice(2);
const output = resolve(root, outputArg);
const rel = relative(root, output);
if (!chrome || !rel || isAbsolute(rel) || rel === '..' || rel.startsWith('..' + sep)) {
  throw new Error('Usage: node tools/demo/capture.mjs <local Chrome executable> [workspace media directory]');
}
await mkdir(dirname(output), { recursive: true });
const work = await mkdtemp(join(dirname(output), '.voip-capture-'));
let browser, child, childExit, capturing = false, frames, shot = 0;

async function until(fn, label, timeout = 10000) {
  const end = performance.now() + timeout;
  do {
    const value = await fn();
    if (value) return value;
    await delay(80);
  } while (performance.now() < end);
  throw new Error('Timed out: ' + label);
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((ok, reject) => {
    socket.addEventListener('open', ok, { once: true });
    socket.addEventListener('error', () => reject(new Error('Local Chrome connection failed')), { once: true });
  });
  let next = 0;
  const pending = new Map();
  socket.addEventListener('message', e => {
    const item = JSON.parse(String(e.data)), request = pending.get(item.id);
    if (!request) return;
    pending.delete(item.id);
    clearTimeout(request.timer);
    if (item.error) request.reject(new Error(request.method + ': ' + item.error.message));
    else request.ok(item.result);
  });
  socket.addEventListener('close', () => {
    for (const r of pending.values()) { clearTimeout(r.timer); r.reject(new Error('Local Chrome disconnected')); }
    pending.clear();
  });
  return {
    send(method, params = {}, sessionId) {
      if (socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('Local Chrome disconnected'));
      const id = ++next;
      return new Promise((ok, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Timed out: ' + method)); }, method === 'Page.captureScreenshot' ? 20_000 : 8_000);
        pending.set(id, { ok, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    },
    close() { socket.close(); },
  };
}

function run(executable, args) {
  return new Promise((ok, reject) => {
    const proc = spawn(executable, args, { cwd: work, stdio: ['ignore', 'ignore', 'inherit'], windowsHide: true });
    proc.once('error', reject);
    proc.once('exit', code => code === 0 ? ok() : reject(new Error(basename(executable) + ' exited ' + code)));
  });
}

async function stopBrowser() {
  if (browser) {
    try { await browser.send('Browser.close'); } catch { /* Chrome can disconnect before returning its close reply. */ }
    browser.close();
    browser = undefined;
  }
  if (child && child.exitCode === null && !child.killed) {
    await Promise.race([childExit, delay(2000)]);
    if (child.exitCode === null) { child.kill(); await childExit; }
  }
}

try {
  const page = await fetch(origin + '/', { redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /id="voip-demo-banner"/, 'Refusing to drive a non-demo application');
  const profile = join(work, 'chrome-profile');
  child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profile, '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--disable-component-update', '--disable-sync', '--disable-default-apps', '--disable-extensions',
    '--disable-domain-reliability', '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', '--lang=en-US',
    '--window-size=' + width + ',' + height, 'about:blank'],
    { cwd: root, stdio: 'ignore', windowsHide: true });
  let spawnError;
  childExit = new Promise(ok => { child.once('error', error => { spawnError = error; ok(); }); child.once('exit', ok); });
  const raw = await until(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error('Local Chrome exited before capture');
    try { return await readFile(join(profile, 'DevToolsActivePort'), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
  }, 'local Chrome startup');
  const [port, route] = raw.trim().split(/\r?\n/);
  assert.match(port, /^\d{1,5}$/);
  assert.match(route, /^\/devtools\/browser\/[0-9a-f-]+$/);
  browser = await connect('ws://127.0.0.1:' + port + route);
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  await browser.send('Target.activateTarget', { targetId });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (name, args) => browser.send(name, args, sessionId);
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  const inspect = async (fn, ...args) => {
    const r = await send('Runtime.evaluate', { expression: '(' + fn.toString() + ')(...' + JSON.stringify(args) + ')', returnByValue: true });
    if (r.exceptionDetails) throw new Error('Demo page inspection failed');
    return r.result.value;
  };
  const wait = (fn, label, ...args) => until(() => inspect(fn, ...args), label);
  const text = (value) => wait((t) => document.body.innerText.includes(t), value, value);
  const locationIs = path => wait((value) => location.pathname === value, path, path);
  const button = name => click('button', name);
  async function click(selector, name, mode = 'exact') {
    const point = await wait((sel, label, match) => {
      const el = [...document.querySelectorAll(sel)].find(node => {
        const value = (node.textContent ?? '').trim().replace(/\s+/g, ' ');
        const r = node.getBoundingClientRect();
        const dialog = document.querySelector('dialog[open]');
        return (match === 'contains' ? value.includes(label) : value === label) &&
          !node.disabled && r.width > 0 && r.height > 0 && (!dialog || dialog.contains(node));
      });
      if (!el) return null;
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    }, 'control ' + name, selector, name, mode);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point });
  }
  async function enter(selector, value) {
    await wait(sel => { const input = document.querySelector(sel); if (!input || input.disabled) return false; input.focus(); return document.activeElement === input; }, selector, selector);
    await send('Input.insertText', { text: value });
  }
  // Do not fire a still image and an animation frame at the compositor together.
  let captureTail = Promise.resolve();
  const snapshot = (name, format = 'png') => {
    const capture = captureTail.then(async () => {
      const { data } = await send('Page.captureScreenshot', { format, ...(format === 'jpeg' ? { quality: 80 } : {}), fromSurface: true });
      await writeFile(join(work, name), Buffer.from(data, 'base64'), { flag: 'wx' });
    });
    captureTail = capture;
    return capture;
  };

  const navigation = await send('Page.navigate', { url: origin + '/login', transitionType: 'typed' });
  if (navigation.errorText) throw new Error('Synthetic entry navigation failed: ' + navigation.errorText);
  try {
    await wait(() => location.origin === 'http://127.0.0.1:41730' && !!document.querySelector('#voip-demo-banner'), 'synthetic notice');
  } catch (error) {
    const diagnostics = await inspect(() => ({ origin: location.origin, path: location.pathname, title: document.title,
      notice: !!document.querySelector('#voip-demo-banner'), preview: document.body?.innerText.slice(0, 180) }));
    console.error('Synthetic navigation:', JSON.stringify(diagnostics));
    throw error;
  }
  await wait(() => {
    const select = document.querySelector('main.login select');
    if (!select) return false;
    if (select.value !== 'en') { select.value = 'en'; select.dispatchEvent(new Event('change', { bubbles: true })); }
    return true;
  }, 'language selector');
  await text('Sign in');
  capturing = true;
  frames = (async () => {
    while (capturing) {
      const started = performance.now();
      await snapshot('frame-' + String(++shot).padStart(5, '0') + '.jpg', 'jpeg');
      await delay(Math.max(0, 1000 / fps - (performance.now() - started)));
    }
  })();
  void frames.catch(() => {});
  await delay(900);
  await enter('main.login input[autocomplete="username"]', 'demo');
  await enter('main.login input[autocomplete="current-password"]', 'demo');
  await button('Sign in');
  await locationIs('/dashboard');
  await text('Admin updates connected');
  await text('Devices reachable');
  await delay(1000);
  await snapshot('dashboard.png');
  await delay(1300);

  await click('nav a[href="/alerts"]', 'Alerts');
  await locationIs('/alerts');
  await wait(() => {
    const cards = [...document.querySelectorAll('main article.panel')];
    return cards[0]?.querySelector('h2')?.textContent?.trim() === 'Platform channel is unavailable' &&
      cards.some(card => card.querySelector('h2')?.textContent?.trim() === 'Device has gone offline');
  }, 'localized channel and device fixture alerts');
  await delay(650);
  await click('main article.panel:first-of-type button', 'Acknowledge alert');
  await wait(() => {
    const card = document.querySelector('main article.panel:first-of-type');
    return !!card && card.innerText.includes('Platform channel is unavailable') &&
      card.innerText.includes('State: Acknowledged') && !card.querySelector('button');
  }, 'channel alert acknowledgement readback');
  await snapshot('alerts.png');
  await delay(1400);

  await click('nav a[href="/devices"]', 'Devices');
  await locationIs('/devices');
  await button('Binding records');
  await wait(() => !!document.querySelector('dialog[open] .slot-list li'), 'binding inventory rows');
  await delay(1100);
  const unused = await wait(() => {
    const row = [...document.querySelectorAll('dialog[open] .slot-list li')].find(el => el.innerText.includes('Unused') && el.querySelector('input:not(:disabled)'));
    return row?.querySelector('input')?.value;
  }, 'unused synthetic binding');
  assert.match(unused, /^[0-9a-f-]{36}$/);
  await click('dialog[open] label.radio', unused, 'contains');
  await button('Review cancellation');
  await text('Review selected binding record');
  await delay(1300);
  await button('Confirm cancellation');
  await text('Cancellation confirmed for ' + unused);
  await delay(800);
  await snapshot('bindings.png');
  await delay(1400);
  await button('Close');
  await click('nav a[href="/sms"]', 'Messages');
  await click('.thread-list a', '+12025550111', 'contains');
  await text('Demo parcel ready at the front desk.');
  await delay(850);
  await enter('textarea:enabled', caption);
  await button('Send message');
  await wait(t => [...document.querySelectorAll('.message-list .message')].some(el => el.innerText.includes(t) && el.innerText.includes('Sent')), 'simulated outgoing SMS', caption);
  await delay(850);
  await snapshot('sms.png');
  await delay(1500);
  capturing = false;
  await frames;
  await stopBrowser();

  const ffmpeg = process.env.FFMPEG || 'ffmpeg';
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-framerate', String(fps), '-i', 'frame-%05d.jpg',
    '-an', '-c:v', 'libx264', '-crf', '22', '-preset', 'fast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', 'walkthrough.mp4']);
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-n', '-i', 'walkthrough.mp4', '-vf',
    'fps=7,scale=800:-2:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4', '-loop', '0', 'walkthrough.gif']);
  await mkdir(output, { recursive: true });
  for (const name of names) {
    await writeFile(join(output, name), await readFile(join(work, name)), { flag: 'wx' });
  }
  console.log('Verified synthetic dashboard, alert acknowledgement, binding cancellation and SMS; exported ' + shot + ' actual Chrome frames.');
} finally {
  capturing = false;
  await frames?.catch(() => {});
  await stopBrowser();
  await rm(work, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 });
}
