import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execFile);
const START_SCRIPT = '/sdcard/Android/data/moe.shizuku.privileged.api/start.sh';

// Ignore unauthorized, offline, malformed, and header lines. Never pass a shell command
// constructed from device output to the host shell.
export function parseDevices(output) {
  return output.split(/\r?\n/).slice(1).flatMap(line => {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2 || parts[1] !== 'device' || !parts[0]) return [];
    const model = parts.find(part => part.startsWith('model:'))?.slice(6) || 'unknown';
    return [{ serial: parts[0], model }];
  });
}

export function createMonitor({ adb, report, allowedSerials, log = console.log }) {
  if (!Array.isArray(allowedSerials) || !allowedSerials.length || allowedSerials.some(s => typeof s !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(s))) throw new Error('A nonempty explicit serial allowlist is required');
  const allowed = new Set(allowedSerials);
  const failures = new Map();
  let running = false;
  async function publish(payload) {
    log(JSON.stringify(payload));
    try { await report(payload); } catch (error) {
      log(JSON.stringify({ event: 'report_failed', serial: payload.serial, detail: String(error.message || error) }));
    }
  }
  async function poll() {
    if (running) return;
    running = true;
    try {
      let devices;
      try { devices = parseDevices(await adb(['devices', '-l'])).filter(device => allowed.has(device.serial)); }
      catch (error) { log(JSON.stringify({ event: 'adb_devices_failed', detail: String(error.message || error) })); return; }
      const present = new Set(devices.map(device => device.serial));
      for (const serial of failures.keys()) if (!present.has(serial)) failures.delete(serial);
      for (const { serial, model } of devices) {
        let active = false;
        try { active = Boolean((await adb(['-s', serial, 'shell', 'pidof', 'shizuku_server'])).trim()); } catch { /* pidof exits 1 when absent */ }
        if (active) {
          failures.delete(serial);
          await publish({ serial, model, result: 'already_running', detail: 'Shizuku process detected' });
          continue;
        }
        try {
          await adb(['-s', serial, 'shell', 'sh', START_SCRIPT]);
          const pid = (await adb(['-s', serial, 'shell', 'pidof', 'shizuku_server'])).trim();
          if (!pid) throw new Error('Shizuku process not detected after start');
          failures.delete(serial);
          await publish({ serial, model, result: 'started', detail: 'Shizuku process detected after start' });
        } catch (error) {
          const count = (failures.get(serial) || 0) + 1;
          failures.set(serial, count);
          await publish({ serial, model, result: 'failed', detail: 'Start or verification failed; consecutive failures: ' + count });
        }
      }
    } finally { running = false; }
  }
  return { poll };
}

export async function run() {
  const port = Number(process.env.VOIP_CORE_PORT || '47860');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid VOIP_CORE_PORT');
  const token = process.env.VOIPGW_SHIZUKU_REPORT_TOKEN;
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || Buffer.from(token, 'base64url').toString('base64url') !== token) {
    throw new Error('Invalid Shizuku reporter credential configuration');
  }
  const adb = async args => (await exec('adb', args, { timeout: 8000, maxBuffer: 1024 * 1024 })).stdout;
  const report = async payload => {
    const response = await fetch('http://127.0.0.1:' + port + '/internal/shizuku-autostart', {
      method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(payload), signal: AbortSignal.timeout(8000), redirect: 'error'
    });
    if (!response.ok) throw new Error('Core returned HTTP ' + response.status);
  };
  const allowedSerials = (process.env.VOIP_SHIZUKU_SERIALS || '').split(',').map(s => s.trim()).filter(Boolean);
  const monitor = createMonitor({ adb, report, allowedSerials });
  await monitor.poll();
  setInterval(() => { void monitor.poll(); }, 10000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run().catch(error => { console.error(error.message); process.exitCode = 1; });
}
