import test from 'node:test';
import assert from 'node:assert/strict';
import { createMonitor, parseDevices } from '../index.mjs';

test('only authorized devices are selected', () => {
  assert.deepEqual(parseDevices('List of devices attached\na device product:p model:Pixel_7 transport_id:1\nb unauthorized usb:1\nc offline model:X\n'), [{ serial: 'a', model: 'Pixel_7' }]);
});
test('running, start, failures and recovery report exact contract', async () => {
  let mode = 'running'; const reports = []; const calls = [];
  const adb = async args => {
    calls.push(args);
    if (args[0] === 'devices') return 'List of devices attached\na device model:Test\n';
    if (args.includes('pidof')) { if (mode === 'running' || mode === 'started') return '42'; throw Error('not running'); }
    if (mode === 'fail') throw Error('adb error');
    mode = 'started'; return '';
  };
  const m = createMonitor({ adb, allowedSerials: ['a'], report: async p => reports.push(p), log: () => {} });
  await m.poll(); mode = 'fail'; await m.poll(); await m.poll(); await m.poll();
  mode = 'stopped'; await m.poll();
  assert.deepEqual(reports.map(p => p.result), ['already_running', 'failed', 'failed', 'failed', 'started']);
  assert.match(reports[3].detail, /consecutive failures: 3/);
  assert.deepEqual(Object.keys(reports[0]).sort(), ['detail','model','result','serial']);
  assert.ok(calls.some(c => c.includes('/sdcard/Android/data/moe.shizuku.privileged.api/start.sh')));
});
test('report failures and device discovery failures do not crash monitor', async () => {
  const logs=[]; let discoveryFails = false;
  const m=createMonitor({ allowedSerials: ['a'], adb: async args => { if (args[0] === 'devices') { if (discoveryFails) throw Error('unavailable'); return 'List of devices attached\na device\n'; } return '42'; }, report: async () => { throw Error('unavailable'); }, log: text => logs.push(JSON.parse(text)) });
  await m.poll(); discoveryFails=true; await m.poll();
  assert.ok(logs.some(x => x.event === 'report_failed'));
  assert.ok(logs.some(x => x.event === 'adb_devices_failed'));
});
test('overlapping ticks do not duplicate startup', async () => {
  let release; let calls=0; const pending=new Promise(resolve => { release=resolve; });
  const m=createMonitor({ allowedSerials: ['a'], adb: async () => { calls++; await pending; return 'List of devices attached\n'; }, report: async () => {}, log: () => {} });
  const first=m.poll(); await m.poll(); assert.equal(calls,1); release(); await first;
});
