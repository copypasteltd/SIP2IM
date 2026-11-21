import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDeviceMessage } from '../../packages/protocol/dist/device.js';
import deviceExamples from '../../packages/protocol/fixtures/device/messages.json' with { type: 'json' };
import { createDevice } from './device.mjs';
import { attachDeviceSocket, createSession } from './runner.mjs';
import { command, fakeClock, helloOk, id, startTime } from './control.fixture.mjs';

const update = (n, payload) => command(n, 'config.update', payload);
const receive = (connection, message) => connection.receive(JSON.stringify(message));
const ackPayload = (refId, error = null) => ({ refId, ok: error === null, error });
const types = sent => sent.map(x => x.type);
const heartbeatTimes = sent => sent.filter(x => x.type === 'heartbeat').map(x => x.ts - startTime);

function fixture(write = () => {}, overrides = {}) {
  const clock = fakeClock();
  const sent = [];
  const session = createSession({ token: 'fixture', deviceId: id('dev'), ...clock, ...overrides });
  const connection = session.start(raw => {
    const event = JSON.parse(raw);
    assert.deepEqual(parseDeviceMessage(event, 'event'), event);
    write(event);
    sent.push(event);
  });
  return { clock, sent, session, connection };
}

function sendUpdate(connection, sent, n, patch, error = null) {
  const before = sent.length;
  const cmd = update(n, patch);
  receive(connection, cmd);
  assert.equal(sent.length, before + 1);
  const ack = sent.at(-1);
  assert.equal(ack.type, 'ack');
  assert.deepEqual(ack.payload, ackPayload(cmd.id, error));
  return ack;
}

test('hello establishes the schedule; heartbeat updates replace it before ACK and locale-only updates do not reset it', () => {
  const observedAtAck = [];
  const { clock, sent, connection } = fixture(event => {
    if (event.type === 'ack') observedAtAck.push([connection.config, [...clock.intervals.values()].map(x => x.delay)]);
  });
  receive(connection, update(1, { heartbeatSec: 1 }));
  clock.advance(15_000);
  connection.heartbeat();
  assert.deepEqual(types(sent), ['hello']);
  assert.equal(connection.config, null);
  assert.equal(clock.intervals.size, 0);

  const hello = helloOk(4, 'zh-CN');
  assert.deepEqual(parseDeviceMessage(hello, 'command'), hello);
  receive(connection, hello);
  assert.deepEqual(types(sent), ['hello', 'status.snapshot']);
  assert.deepEqual(connection.config, hello.payload.config);
  const retired = [...clock.intervals.values()][0];
  clock.advance(3_999);
  assert.deepEqual(heartbeatTimes(sent), []);
  clock.advance(1);
  assert.deepEqual(heartbeatTimes(sent), [19_000]);
  clock.advance(1_000);

  const a = sendUpdate(connection, sent, 2, { heartbeatSec: 2, locale: 'zh-HK' });
  assert.deepEqual(observedAtAck[0], [{ heartbeatSec: 2, locale: 'zh-HK' }, [2_000]]);
  retired.callback(); // A previously queued tick must not send after the update.
  clock.advance(1_000);
  assert.deepEqual(sendUpdate(connection, sent, 2, { locale: 'zh-HK', heartbeatSec: 2 }), a);
  sendUpdate(connection, sent, 2, { heartbeatSec: 5 }, 'CONFLICT');
  sendUpdate(connection, sent, 3, { locale: 'en' });
  assert.deepEqual(observedAtAck.at(-1), [{ heartbeatSec: 2, locale: 'en' }, [2_000]]);
  assert.deepEqual(sendUpdate(connection, sent, 2, { heartbeatSec: 2, locale: 'zh-HK' }), a);
  assert.deepEqual(connection.config, { heartbeatSec: 2, locale: 'en' });
  connection.config.heartbeatSec = 99;
  clock.advance(999);
  assert.deepEqual(heartbeatTimes(sent), [19_000]);
  clock.advance(1);
  assert.deepEqual(heartbeatTimes(sent), [19_000, 22_000]);

  receive(connection, helloOk(1, 'duplicate-hello'));
  assert.deepEqual(connection.config, { heartbeatSec: 2, locale: 'en' });
  assert.equal(types(sent).filter(type => type === 'status.snapshot').length, 1);
  clock.advance(4_000);
  assert.deepEqual(heartbeatTimes(sent), [19_000, 22_000, 24_000, 26_000]);
  assert.equal(sent.at(-1).payload.shizuku, 'unknown');
  connection.close();
  assert.equal(clock.intervals.size, 0);
});

test('only a complete, matching v1 hello can authorize configuration, SMS, or heartbeats', () => {
  const { clock, sent, session, connection } = fixture();
  session.sms('+12025550123', 'fixture');
  const hello = helloOk(2);
  const malformed = [
    { type: 'hello.ok' }, { ...hello, v: 2 }, { ...hello, id: 'cmd_bad' },
    helloOk(2, 'en', id('dev', 2)), helloOk(0), helloOk(2, null),
    { ...hello, payload: { ...hello.payload, serverTime: -1 } },
    { ...hello, payload: { ...hello.payload, config: { heartbeatSec: 2 } } },
    { ...hello, payload: { ...hello.payload, config: null } },
  ];
  for (const invalid of malformed) receive(connection, invalid);
  receive(connection, update(1, { heartbeatSec: 1 }));
  const sms = command(2, 'sms.send', { taskId: id('tsk'), slot: 0, subId: 1, to: '5550100', body: 'fixture' });
  receive(connection, sms);
  clock.advance(30_000);
  assert.deepEqual(types(sent), ['hello']);
  assert.equal(connection.config, null);
  assert.equal(clock.intervals.size, 0);
  assert.equal(session.report().pending, 1);
  receive(connection, hello);
  assert.deepEqual(types(sent), ['hello', 'status.snapshot', 'sms.received']);
  receive(connection, sms);
  assert.deepEqual(types(sent).slice(-2), ['ack', 'sms.result']);
  const smsAck = sent.at(-2);
  assert.deepEqual(sent.at(-1).payload, { taskId: id('tsk'), state: 'sent', errorCode: null });
  receive(connection, sms);
  assert.deepEqual(sent.at(-1), smsAck);
  assert.equal(types(sent).filter(type => type === 'sms.result').length, 1);
  connection.close();
});

test('wire-valid empty or malformed updates never get a positive ACK, including duplicates after success', () => {
  const { clock, sent, connection, session } = fixture();
  receive(connection, helloOk(9, 'en'));
  const applied = { heartbeatSec: 6, locale: 'zh-CN' };
  const original = sendUpdate(connection, sent, 1, applied);
  const [interval] = clock.intervals.values();
  const example = deviceExamples.find(({ valid }) => valid.type === 'config.update').valid;
  assert.deepEqual(parseDeviceMessage(example, 'command'), example);
  receive(connection, example);
  assert.deepEqual(sent.at(-1).payload, ackPayload(example.id, 'BAD_MESSAGE'));

  const invalid = [null, [], 'value', undefined, { unsupported: true },
    { heartbeatSec: 4, locale: 'en', unsupported: true }, { heartbeatSec: 4, locale: null },
    ...[-5, 0, 1.5, '3', true, null, 2_147_484, Number.MAX_SAFE_INTEGER].map(heartbeatSec => ({ heartbeatSec, locale: 'wrong' })),
  ];
  for (const patch of invalid) {
    sendUpdate(connection, sent, 1, patch, 'BAD_MESSAGE');
    assert.deepEqual(connection.config, applied);
    assert.deepEqual([...clock.intervals.values()], [interval]);
  }
  assert.deepEqual(sendUpdate(connection, sent, 1, applied), original);

  const count = sent.length;
  const cmd = update(2, { heartbeatSec: 1 });
  for (const invalidEnvelope of [{ ...cmd, v: 2 }, { ...cmd, ts: undefined }, { ...cmd, id: 'cmd_bad' }]) {
    receive(connection, invalidEnvelope);
  }
  assert.equal(sent.length, count);
  assert.equal(session.report().errors, 3);
  clock.advance(5_999);
  assert.deepEqual(heartbeatTimes(sent), []);
  clock.advance(1);
  assert.deepEqual(heartbeatTimes(sent), [6_000]);
  connection.close();
});

test('unsupported and unapplied configuration cannot get a positive device receipt', () => {
  const device = createDevice({ token: 'fixture' });
  const message = update(1, { heartbeatSec: 2 });
  const [ack] = device.command(message);
  assert.deepEqual(parseDeviceMessage(ack, 'event').payload, ackPayload(message.id, 'CAPABILITY_UNSUPPORTED'));

  const clock = fakeClock();
  const sent = [];
  let failure = 'return';
  const session = createSession({ token: 'fixture', ...clock,
    setIntervalFn(callback, delay) {
      if (failure === 'return') return false;
      if (failure === 'throw') throw new Error('fake scheduling failure');
      return clock.setIntervalFn(callback, delay);
    },
  });
  const connection = session.start(raw => sent.push(JSON.parse(raw)));
  receive(connection, helloOk(3));
  assert.equal(connection.config, null);
  assert.deepEqual(types(sent), ['hello']);
  failure = null;
  receive(connection, helloOk(3));
  const [originalInterval] = clock.intervals.values();
  failure = 'throw';
  const negative = sendUpdate(connection, sent, 1, { heartbeatSec: 2, locale: 'zh-CN' }, 'INTERNAL');
  assert.deepEqual(connection.config, { heartbeatSec: 3, locale: 'en' });
  assert.deepEqual([...clock.intervals.values()], [originalInterval]);
  clock.advance(3_000);
  assert.deepEqual(heartbeatTimes(sent), [3_000]);
  failure = null;
  assert.deepEqual(sendUpdate(connection, sent, 1, { heartbeatSec: 2, locale: 'zh-CN' }, 'INTERNAL'), negative);
  sendUpdate(connection, sent, 2, { heartbeatSec: 2, locale: 'zh-CN' });
  clock.advance(2_000);
  assert.deepEqual(heartbeatTimes(sent), [3_000, 5_000]);
  connection.close();
});

test('minimum and upper native-timer intervals are scheduled without coercion', () => {
  const { clock, sent, connection } = fixture();
  receive(connection, helloOk(1));
  clock.advance(999);
  assert.deepEqual(heartbeatTimes(sent), []);
  clock.advance(1);
  assert.deepEqual(heartbeatTimes(sent), [1_000]);
  for (const [n, heartbeatSec] of [[1, 86_400], [2, 2_147_483]]) {
    sendUpdate(connection, sent, n, { heartbeatSec });
    assert.deepEqual([...clock.intervals.values()].map(x => x.delay), [heartbeatSec * 1_000]);
  }
  connection.close();
});

class FakePort extends EventTarget {
  readyState = 0;
  sent = [];
  onWrite = () => {};
  send(raw) {
    assert.equal(this.readyState, 1);
    const event = JSON.parse(raw);
    this.sent.push(event);
    this.onWrite(event);
  }
  open() { this.readyState = 1; this.dispatchEvent(new Event('open')); }
  receive(message) { this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(message) })); }
  close(code = 1000) { this.readyState = 3; this.dispatchEvent(Object.assign(new Event('close'), { code })); }
}

test('the CLI socket adapter fences stale messages, timers, closes and config receipts after replacement', () => {
  const clock = fakeClock();
  const session = createSession({ token: 'fixture', deviceId: id('dev'), ...clock });
  const first = new FakePort(), second = new FakePort();
  attachDeviceSocket(session, first);
  const detach = attachDeviceSocket(session, second);
  first.onWrite = event => { if (event.type === 'hello') first.receive(helloOk(12)); };
  first.open();
  assert.deepEqual(types(first.sent), ['hello', 'status.snapshot']);
  first.receive(update(1, { heartbeatSec: 2, locale: 'zh-HK' }));
  const oldTimer = [...clock.intervals.values()][0];
  assert.equal(first.sent.at(-1).payload.ok, true);
  clock.advance(2_000);
  assert.deepEqual(heartbeatTimes(first.sent), [2_000]);

  second.open();
  first.receive(helloOk(1));
  first.receive(update(2, { heartbeatSec: 1 }));
  first.close();
  oldTimer.callback();
  clock.advance(10_000);
  assert.deepEqual(types(first.sent), ['hello', 'status.snapshot', 'ack', 'heartbeat']);
  assert.deepEqual(types(second.sent), ['hello']);
  assert.equal(clock.intervals.size, 0);

  second.receive(helloOk(4, 'en'));
  clock.advance(4_000);
  assert.deepEqual(heartbeatTimes(second.sent), [16_000]);
  // The number matches the old receipt but the new attachment applies its own command.
  second.receive(update(1, { heartbeatSec: 1 }));
  assert.deepEqual(second.sent.at(-1).payload, ackPayload(id('cmd', 1)));
  clock.advance(1_000);
  assert.deepEqual(heartbeatTimes(second.sent), [16_000, 17_000]);
  detach();
  second.receive(update(3, { heartbeatSec: 2 }));
  second.close();
  clock.advance(10_000);
  assert.deepEqual(heartbeatTimes(second.sent), [16_000, 17_000]);
  assert.equal(clock.intervals.size, 0);
});
