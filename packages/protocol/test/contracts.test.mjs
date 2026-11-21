import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseDeviceMessage, parseAdapterMessage, adminRequests } from '../dist/index.js';
const fixture = async path => JSON.parse(await readFile(new URL('../fixtures/' + path + '.json', import.meta.url), 'utf8'));
for (const [name, parse] of [['device/heartbeat', value => parseDeviceMessage(value, 'event')], ['ipc/hello', parseAdapterMessage], ['admin/login', value => adminRequests.login.parse(value)]]) {
  test(name + ' shared valid and invalid examples', async () => {
    const valid = await fixture(name + '.valid');
    assert.deepEqual(parse(valid), valid);
    const invalid = await fixture(name + '.invalid');
    assert.throws(() => parse(invalid));
  });
}
