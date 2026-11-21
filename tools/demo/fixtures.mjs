const minute = 60_000;

// NANP reserves 555-0100 through 555-0199 for fictional use.
export const demoNumber = /^(?:\+1)?20255501[0-9]{2}$/;
export const locales = ['zh-CN', 'zh-HK', 'en'];
export const platforms = ['qq', 'telegram'];
export const bindingId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const fixtureId = (prefix, ordinal) => prefix + '_' + String(ordinal).padStart(26, '0');
export const bindingRecordId = ordinal => '00000000-0000-4000-8000-' + String(ordinal).padStart(12, '0');

export function syntheticNumber(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const compact = value.trim().replace(/[ ()-]/g, '');
  if (!demoNumber.test(compact)) return null;
  return compact.startsWith('+1') ? compact : '+1' + compact;
}

export function seedDemo(at) {
  const devices = [
    { name: 'Studio handset · 演示主机', model: 'Demo A1', online: true, enabled: true, paused: false, capabilityLevel: 'L2', network: 'wifi', battery: 84, shizuku: 'running', age: 1 },
    { name: 'Desk backup · 桌面备机', model: 'Demo A2', online: true, enabled: true, paused: true, capabilityLevel: 'L1', network: 'cell', battery: 61, shizuku: 'stopped', age: 3 },
    { name: 'Field spare · 离线备用', model: 'Demo B1', online: false, enabled: true, paused: false, capabilityLevel: 'L1', network: 'wifi', battery: 38, shizuku: 'unknown', age: 192 },
  ].map((sample, index) => {
    const n = index + 1;
    const id = fixtureId('dev', n);
    const lastSeenAt = at - sample.age * minute;
    const observed = value => ({ value, observedAt: lastSeenAt, stale: !sample.online });
    const sims = [{
      id: fixtureId('sim', n), slot: 0, carrier: 'Demo Mobile',
      number: n === 2 ? null : '+1202555010' + n, state: sample.online ? 'ready' : 'absent',
      numberSource: n === 2 ? null : 'manual', needsReview: n === 2, lastSeenAt,
    }];
    if (n === 1) sims.push({
      id: fixtureId('sim', 4), slot: 1, carrier: 'Demo Mobile', number: '+12025550104',
      state: 'ready', numberSource: 'manual', needsReview: false, lastSeenAt,
    });
    return {
      id, name: sample.name, model: sample.model, online: sample.online, enabled: sample.enabled, paused: sample.paused,
      capabilityLevel: sample.capabilityLevel, callEnabled: false, lastSeenAt, inCall: false, revoked: false, sims,
      status: { battery: observed(sample.battery), network: observed(sample.network), shizuku: observed(sample.shizuku) },
      probes: {
        sms: { result: n === 1 ? 'ok' : 'unknown', probedAt: lastSeenAt, detail: 'Synthetic observation / 合成观测' },
      },
      recentEvents: [], usbAutostart: null,
    };
  });

  const messages = [
    [1, 1, 'in', '0111', 'Demo parcel ready at the front desk. / 演示包裹可在前台领取。', 5],
    [1, 1, 'out', '0111', 'Thanks, I will pick it up after 14:00. / 谢谢，我会在 14:00 后领取。', 12],
    [1, 1, 'in', '0111', 'Pickup window 13:30–17:00. / 领取时间为 13:30–17:00。', 13],
    [1, 4, 'in', '0122', 'Demo shift handover confirmed. / 演示交接已确认。', 39],
    [1, null, 'in', '0133', 'Sample imported message with no SIM assignment. / 此演示历史短信未分配 SIM。', 73],
    [3, 3, 'out', '0144', 'Inventory complete for the demo. / 演示库存盘点已完成。', 320],
  ].map(([device, sim, direction, suffix, body, age], i) => {
    const occurredAt = at - age * minute;
    const task = direction === 'out' ? {
      id: fixtureId('tsk', i + 1), state: 'sent', origin: 'web', errorCode: null, updatedAt: occurredAt + 700,
    } : null;
    return {
      id: fixtureId('sms', i + 1), deviceId: fixtureId('dev', device), simId: sim === null ? null : fixtureId('sim', sim),
      direction, peer: '+1202555' + suffix, peerKind: 'e164', body, parts: 1, occurredAt, task,
    };
  });

  const calls = [
    ['web_out', '0111', null, 94, 2, 'normal_clearing'],
    ['platform_out', '0122', 'qq', 275, 1, 'normal_clearing'],
  ].map(([kind, suffix, platform, age, duration, endCause], i) => {
    const startedAt = at - age * minute;
    const endedAt = startedAt + duration * minute;
    return {
      id: fixtureId('ses', i + 1), kind, state: 'ended', platform, peer: '+1202555' + suffix,
      deviceId: devices[0].id, simId: devices[0].sims[i].id, startedAt, endedAt, endCause,
      promptPlayed: false, earlyMediaForwarded: false,
      legs: [
        { id: fixtureId('leg', i * 2 + 1), type: 'cellular', state: 'ended' },
        { id: fixtureId('leg', i * 2 + 2), type: platform ? 'platform' : 'browser', state: 'ended' },
      ],
      events: [
        { id: fixtureId('evt', i * 3 + 1), event: 'call.created', ts: startedAt },
        { id: fixtureId('evt', i * 3 + 2), event: 'call.bridged', ts: startedAt + 5000 },
        { id: fixtureId('evt', i * 3 + 3), event: 'call.ended', ts: endedAt },
      ],
    };
  });

  return {
    devices, messages, calls,
    channels: [
      { platform: 'qq', alias: 'Desk adapter · 桌面适配器', state: 'offline', pairedUser: { displayName: 'Demo operator · 演示操作员' } },
      { platform: 'telegram', alias: 'Demo Telegram', state: 'logged_out', pairedUser: null },
    ].map(channel => ({
      ...channel, voiceVerified: false,
      capabilities: { login: false, sendMessage: false, receiveMessage: false, dial: false, receiveAudio: false, sendAudio: false, maxConcurrentCalls: 0 },
    })),
    settings: {
      defaultDeviceId: devices[0].id, inboundPlatform: 'qq', inboundRingTimeoutSec: 20,
      outboundUserAnswerTimeoutSec: 15, outboundCalleeAnswerTimeoutSec: 30, outboundCallbackRingTimeoutSec: 30,
      alertPushIntervalSec: 1800, earlyMediaThresholdDbfs: -50, smsForward: false, smsRatePerMin: 10,
      heartbeatSec: 30, offlineAfterSec: 90, botLocale: 'zh-CN',
    },
    bindings: [
      { recordId: bindingRecordId(1), createdAt: at - 8 * minute, expiresAt: at - 3 * minute, usedAt: at - 7 * minute,
        deviceId: devices[2].id, cancelledAt: null, protocolVersion: 2, teardownPending: false },
      { recordId: bindingRecordId(2), createdAt: at, expiresAt: at + 5 * minute, usedAt: null,
        deviceId: null, cancelledAt: null, protocolVersion: null, teardownPending: false },
    ],
    alerts: [
      { id: fixtureId('alt', 1), type: 'device.offline', subjectType: 'device', subjectId: devices[2].id, severity: 'warning', state: 'open', firstAt: at - 182 * minute, lastAt: at - 182 * minute },
    ],
    commands: [
      { id: fixtureId('cmd', 1), platform: 'qq', kind: 'sms', state: 'completed', fromSimId: devices[0].sims[0].id,
        fromNumber: devices[0].sims[0].number, toNumber: '+12025550144', toKind: 'e164',
        replies: [{ text: 'Synthetic command accepted. / 已接受合成指令。', ts: at - 320 * minute }], createdAt: at - 320 * minute },
    ],
    audit: [
      { id: fixtureId('aud', 1), action: 'demo.seed', targetId: null, detail: { synthetic: true }, ts: at },
    ],
  };
}

export function publicDevice({ revoked, probes, recentEvents, usbAutostart, ...device }) {
  return device;
}

export function activeDevices(state) {
  return state.devices.filter(device => !device.revoked);
}

export function dashboard(state, now) {
  const devices = activeDevices(state);
  const sims = devices.flatMap(device => device.sims);
  const byLevel = { L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 };
  for (const device of devices) byLevel[device.capabilityLevel]++;
  const ready = sim => sim.state === 'ready' && sim.lastSeenAt <= now && now - sim.lastSeenAt <= 7_200_000;
  const smsReady = devices.filter(device => device.online && device.enabled && !device.paused && device.sims.some(ready)).length;
  const open = state.alerts.filter(alert => alert.state === 'open');
  return {
    devices: {
      total: devices.length, online: devices.filter(device => device.online).length,
      offline: devices.filter(device => !device.online).length, paused: devices.filter(device => device.paused).length, byLevel,
    },
    sims: { total: sims.length, ready: sims.filter(ready).length,
      numberKnown: sims.filter(sim => sim.number !== null).length, needsReview: sims.filter(sim => sim.needsReview).length },
    capability: { smsReady, callReady: 0, inCall: 0 },
    channels: state.channels.map(({ platform, state: accountState, pairedUser, voiceVerified }) => ({
      platform, state: accountState, paired: pairedUser !== null, voiceVerified, busy: false,
      isInbound: platform === state.settings.inboundPlatform,
    })),
    alerts: { open: open.length, critical: open.filter(alert => alert.severity === 'critical').length },
  };
}

export function threads(messages) {
  const grouped = new Map();
  for (const message of messages) {
    const { deviceId, simId, peer, body, occurredAt } = message;
    const key = [deviceId, simId, peer].join(':');
    if (!grouped.has(key)) grouped.set(key, { key, deviceId, simId, peer, lastBody: body, lastAt: occurredAt });
  }
  return [...grouped.values()];
}
