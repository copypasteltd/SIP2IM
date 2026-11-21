import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDeviceMessage } from '../../packages/protocol/dist/device.js';
import { createBrowserCallDriver } from './browser-call-driver.fixture.mjs';
import { createSession } from './runner.mjs';

const now = () => 1700000000123;
const id = (prefix, value = 1) => prefix + '_' + String(value).padStart(26, '0');
const callId = id('cal');
const generation = id('gen');
const media = {
  sessionId: id('ses'), legId: id('leg'), path: '/ws/media?session=' + id('ses') + '&leg=' + id('leg'), format: 2,
};
const dial = { callId, generation, to: '12345', subId: 1, slot: 0, media };
const hangup = { callId, generation };
const command = (number, type, payload) => JSON.stringify({ v: 1, id: id('cmd', number), ts: now(), type, payload });
const helloOk = command(90, 'hello.ok', { deviceId: id('dev'), serverTime: now(), config: { heartbeatSec: 30, locale: 'en' } });
const eventAck = refId => command(91, 'ack', { refId, ok: true, error: null });

function fixture({ openMedia } = {}) {
  const opened = [];
  let closed = 0;
  const createCallDriver = createBrowserCallDriver({ now, openMedia: leg => {
    opened.push(leg);
    return openMedia ? openMedia(leg) : { ready: true, close: () => { closed++; } };
  } });
  const session = createSession({ token: 'fixture', now, createCallDriver });
  function connect(write = () => {}) {
    const frames = [];
    const connection = session.start(raw => {
      const event = JSON.parse(raw);
      const result = write(event);
      if (result !== undefined) return result;
      frames.push(event);
    });
    const send = (number, type, payload) => {
      const before = frames.length;
      connection.receive(command(number, type, payload));
      const events = frames.slice(before);
      for (const event of events) assert.deepEqual(parseDeviceMessage(event, 'event'), event);
      return events;
    };
    return { ...connection, frames, send, helloOk: () => connection.receive(helloOk) };
  }
  return { session, connect, opened, closed: () => closed };
}

const ackFor = (ref, error = null) => ({ refId: id('cmd', ref), ok: error === null, error });
const assertRejected = (events, ref, error) => {
  assert.equal(events.length, 1);
  assert.equal(events[0].type, 'ack');
  assert.deepEqual(events[0].payload, ackFor(ref, error));
};

test('negotiated outbound calls require the exact generation and keep capability and probe evidence synthetic', () => {
  const f = fixture();
  const socket = f.connect();
  assert.deepEqual(parseDeviceMessage(socket.frames[0], 'event').payload.capabilities, { callGeneration: true });
  assert.deepEqual(socket.send(1, 'call.dial', dial), []);
  assert.equal(f.opened.length, 0);
  socket.helloOk();
  socket.heartbeat();
  const snapshot = parseDeviceMessage(socket.frames[1], 'event');
  assert.equal(snapshot.payload.capabilityLevel, 'L1');
  assert.ok(Object.values(snapshot.payload.probes).every(probe => probe.result === 'untested'));
  assert.equal(socket.frames[2].payload.shizuku, 'unknown');

  assertRejected(socket.send(1, 'call.dial', { ...dial, generation: undefined }), 1, 'BAD_MESSAGE');
  const [ack, dialing, active] = socket.send(2, 'call.dial', dial);
  assert.deepEqual(ack.payload, ackFor(2));
  assert.deepEqual([dialing, active].map(event => [event.type, event.payload]), [
    ['call.state', { ...hangup, state: 'dialing', cause: null }],
    ['call.state', { ...hangup, state: 'active', cause: null }],
  ]);
  assert.deepEqual(f.opened, [media]);
  assert.deepEqual(socket.send(2, 'call.dial', dial), [ack]);
  assertRejected(socket.send(2, 'call.dial', { ...dial, generation: id('gen', 2) }), 2, 'CONFLICT');
  assertRejected(socket.send(3, 'call.hangup', { callId }), 3, 'BAD_MESSAGE');
  assertRejected(socket.send(4, 'call.hangup', { ...hangup, generation: 'gen_invalid' }), 4, 'BAD_MESSAGE');
  assertRejected(socket.send(5, 'call.hangup', { ...hangup, generation: id('gen', 2) }), 5, 'CALL_NOT_FOUND');
  assertRejected(socket.send(6, 'call.hangup', { ...hangup, callId: id('cal', 2) }), 6, 'CALL_NOT_FOUND');
  assert.equal(f.closed(), 0);
  const end = socket.send(7, 'call.hangup', hangup);
  assert.deepEqual(end.map(event => [event.type, event.payload]), [
    ['ack', ackFor(7)], ['call.state', { ...hangup, state: 'disconnected', cause: 'local_hangup' }],
  ]);
  assert.deepEqual(socket.send(7, 'call.hangup', hangup), [end[0]]);
  assert.equal(f.opened.length, 1);
  assert.equal(f.closed(), 1);
  socket.close();
});

test('socket replacement clears the old call and progress without disrupting SMS outbox replay', () => {
  const f = fixture();
  const first = f.connect();
  first.helloOk();
  first.send(1, 'call.dial', dial);
  const smsResult = first.send(2, 'sms.send', { taskId: id('tsk'), slot: 0, subId: 1, to: '12345', body: 'fixture' })[1];
  assert.equal(smsResult.payload.state, 'sent');

  const second = f.connect();
  first.receive(eventAck(smsResult.id));
  first.close();
  assert.equal(f.closed(), 1);
  second.helloOk();
  assert.deepEqual(second.frames.slice(1).map(event => event.type), ['status.snapshot', 'sms.result']);
  assert.deepEqual(second.frames.at(-1), smsResult);
  second.receive(eventAck(smsResult.id));
  assert.equal(f.session.report().pending, 0);
  assertRejected(second.send(1, 'call.dial', dial), 1, 'CONFLICT');
  assertRejected(second.send(3, 'call.hangup', hangup), 3, 'CALL_NOT_FOUND');

  const next = { callId, generation: id('gen', 2) };
  assert.equal(second.send(4, 'call.dial', { ...dial, ...next }).at(-1).payload.state, 'active');
  assert.deepEqual(first.send(5, 'call.hangup', next), []);
  assertRejected(second.send(5, 'call.hangup', hangup), 5, 'CALL_NOT_FOUND');
  assert.equal(f.closed(), 1);
  const terminal = second.send(6, 'call.hangup', next)[1];
  const third = f.connect();
  third.helloOk();
  assert.deepEqual(third.frames.slice(1).map(event => event.type), ['status.snapshot', 'call.state']);
  assert.deepEqual(third.frames.at(-1), terminal);
  third.receive(eventAck(terminal.id));
  assert.equal(f.session.report().pending, 0);
  assert.equal(f.closed(), 2);
  third.close();
});

test('failed or unconfirmed fake media never emits positive activation or terminal evidence', () => {
  let closes = 0;
  const dialFailures = [
    () => { throw new Error('failed open'); },
    () => ({ ready: false, close() { closes++; } }),
    () => ({ ready: true, ok: false, close() { closes++; } }),
    () => ({ ready: true, error: new Error('failed open'), close() { closes++; } }),
    () => Promise.reject(new Error('failed asynchronous open')),
  ];
  for (const openMedia of dialFailures) {
    const f = fixture({ openMedia });
    const socket = f.connect();
    socket.helloOk();
    assertRejected(socket.send(1, 'call.dial', dial), 1, 'CAPABILITY_UNSUPPORTED');
    assertRejected(socket.send(2, 'call.hangup', hangup), 2, 'CALL_NOT_FOUND');
    socket.close();
  }
  assert.equal(closes, 3);

  for (const close of [() => false, () => { throw new Error('failed close'); }, () => Promise.reject(new Error('failed asynchronous close'))]) {
    const f = fixture({ openMedia: () => ({ ready: true, close }) });
    const socket = f.connect();
    socket.helloOk();
    assert.equal(socket.send(1, 'call.dial', dial).at(-1).payload.state, 'active');
    const end = socket.send(2, 'call.hangup', hangup);
    assertRejected(end, 2, 'TIMEOUT_UNKNOWN');
    assert.deepEqual(socket.send(2, 'call.hangup', hangup), end);
    const replacement = f.connect();
    replacement.helloOk();
    assert.deepEqual(replacement.frames.slice(1).map(event => event.type), ['status.snapshot']);
    replacement.close();
  }
});

test('an error on the control transport stops call effects and cannot replay unsent evidence', () => {
  const failDialAck = event => event.type === 'ack' ? { ok: false } : undefined;
  const throwOnDialAck = event => { if (event.type === 'ack') throw new Error('failed send'); };
  const failTerminal = event => event.type === 'call.state' && event.payload.state === 'disconnected'
    ? Promise.reject(new Error('failed send')) : undefined;
  for (const write of [failDialAck, throwOnDialAck, failTerminal]) {
    const f = fixture();
    const socket = f.connect(write);
    socket.helloOk();
    const dialEvents = socket.send(1, 'call.dial', dial);
    if (write !== failTerminal) {
      assert.deepEqual(dialEvents, []);
    } else {
      assert.equal(dialEvents.at(-1).payload.state, 'active');
      const end = socket.send(2, 'call.hangup', hangup);
      assert.deepEqual(end.map(event => event.payload), [ackFor(2)]);
    }
    assert.equal(f.closed(), 1);
    assert.equal(f.session.report().errors, 1);
    assert.equal(f.session.report().pending, 0);
    const replacement = f.connect();
    replacement.helloOk();
    assert.deepEqual(replacement.frames.slice(1).map(event => event.type), ['status.snapshot']);
    replacement.close();
  }
});

test('a failed replay preserves the previously sent terminal event until a confirmed write and ACK', () => {
  const f = fixture();
  const first = f.connect();
  first.helloOk();
  first.send(1, 'call.dial', dial);
  const terminal = first.send(2, 'call.hangup', hangup)[1];

  const second = f.connect(event => {
    if (event.id !== terminal.id) return;
    second.receive(eventAck(event.id));
    return false;
  });
  second.helloOk();
  assert.deepEqual(second.frames.map(event => event.type), ['hello', 'status.snapshot']);
  assert.deepEqual(f.session.report().latenciesMs, []);
  assert.equal(f.session.report().pending, 1);

  const third = f.connect(event => {
    if (event.id === terminal.id) third.receive(eventAck(event.id));
  });
  third.helloOk();
  assert.deepEqual(third.frames.at(-1), terminal);
  assert.deepEqual(f.session.report().latenciesMs, [0]);
  assert.equal(f.session.report().pending, 0);
  third.close();
});

test('a failed terminal write remains ineligible during a synchronous socket replacement', () => {
  const f = fixture();
  let replacement;
  const first = f.connect(event => {
    if (event.payload.state !== 'disconnected') return;
    first.receive(eventAck(event.id));
    replacement = f.connect();
    replacement.helloOk();
    return { error: new Error('failed write after replacement') };
  });
  first.helloOk();
  first.send(1, 'call.dial', dial);
  assert.deepEqual(first.send(2, 'call.hangup', hangup).map(event => event.payload), [ackFor(2)]);
  assert.ok(replacement);
  assert.deepEqual(replacement.frames.map(event => event.type), ['hello', 'status.snapshot']);
  assert.equal(f.session.report().pending, 0);
  assert.deepEqual(f.session.report().latenciesMs, []);
  assert.equal(f.session.report().errors, 1);
  assert.equal(f.closed(), 1);
  assertRejected(replacement.send(3, 'call.hangup', hangup), 3, 'CALL_NOT_FOUND');
  replacement.close();
});
