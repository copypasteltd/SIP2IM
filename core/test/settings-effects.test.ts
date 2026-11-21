import { expect, it, vi } from 'vitest';
import { SettingsService } from '../src/settings/service.js';
import type { Settings } from '../src/settings/schema.js';

const defaults: Settings = { inboundPlatform:'qq', inboundRingTimeoutSec:20, outboundUserAnswerTimeoutSec:15, outboundCalleeAnswerTimeoutSec:30, outboundCallbackRingTimeoutSec:30, smsForward:true, smsRatePerMin:10, defaultDeviceId:null, botLocale:'zh-CN', heartbeatSec:30, offlineAfterSec:90, alertPushIntervalSec:1800, earlyMediaThresholdDbfs:-50 };

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it('continues after rejected publish and device effects while preserving local ordering', async () => {
  let value = { ...defaults };
  const firstPublish = deferred();
  const firstDevices = deferred();
  const firstDeviceStarted = deferred();
  const secondDeviceStarted = deferred();
  const events: string[] = [];
  const reporter = vi.fn((effect: string) => { events.push('report:' + effect); });
  const service = new SettingsService({
    get: async () => ({ ...value }),
    update: async patch => { const before = { ...value }; value = { ...value, ...patch }; return { before, after: { ...value } }; },
  }, {
    publish: settings => { events.push('publish:' + settings.heartbeatSec); return settings.heartbeatSec === 40 ? firstPublish.promise : undefined; },
    updateDevices: config => {
      events.push('devices:' + config.heartbeatSec + ':' + config.locale);
      if (config.heartbeatSec === 40) { firstDeviceStarted.resolve(); return firstDevices.promise; }
      secondDeviceStarted.resolve();
    },
  }, reporter);

  expect((await service.update({ heartbeatSec: 40 })).heartbeatSec).toBe(40);
  expect((await service.update({ heartbeatSec: 50, botLocale: 'en' })).heartbeatSec).toBe(50);
  expect((await service.get()).heartbeatSec).toBe(50);
  expect(events).toEqual(['publish:40']);
  firstPublish.reject(new Error('private publish data'));
  await firstDeviceStarted.promise;
  expect(events).toEqual(['publish:40', 'report:publish', 'devices:40:zh-CN']);
  firstDevices.reject(new Error('private device data'));
  await secondDeviceStarted.promise;
  expect(events).toEqual(['publish:40', 'report:publish', 'devices:40:zh-CN', 'report:updateDevices', 'publish:50', 'devices:50:en']);
  expect(reporter.mock.calls).toEqual([['publish'], ['updateDevices']]);
});

it('isolates synchronous effect and reporter throws and skips unchanged device config', async () => {
  let value = { ...defaults };
  const done = deferred();
  const events: string[] = [];
  const service = new SettingsService({
    get: async () => value,
    update: async patch => { const before = { ...value }; value = { ...value, ...patch }; return { before, after: { ...value } }; },
  }, {
    publish: settings => { events.push('publish:' + settings.botLocale); if (settings.botLocale === 'en') throw new Error('private'); done.resolve(); },
    updateDevices: config => { events.push('devices:' + config.locale); throw new Error('private'); },
  }, effect => { events.push('report:' + effect); throw new Error('reporter failed'); });

  await service.update({ botLocale: 'en' });
  await service.update({ botLocale: 'zh-HK' });
  await done.promise;
  // The second publish is observed before its device effect has settled.
  await vi.waitFor(() => expect(events).toEqual(['publish:en', 'report:publish', 'devices:en', 'report:updateDevices', 'publish:zh-HK', 'devices:zh-HK', 'report:updateDevices']));
  const last = deferred();
  let publishes = 0;
  const noChange = new SettingsService({ get: async () => value, update: async () => ({ before: value, after: value }) }, { publish: () => { if (++publishes === 2) last.resolve(); }, updateDevices: () => { throw new Error('unexpected device update'); } }, effect => events.push('unexpected:' + effect));
  await noChange.update({ smsForward: false });
  await noChange.update({ smsForward: true });
  await last.promise;
  expect(events.some(event => event.startsWith('unexpected:'))).toBe(false);
});
