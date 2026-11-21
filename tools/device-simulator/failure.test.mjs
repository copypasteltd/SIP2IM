import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './runner.mjs';
import { command, fakeClock, helloOk } from './control.fixture.mjs';

function fixture(openMedia, beforeStart = () => {}) {
  const sent = [];
  const session = createSession({ token: 'fixture', send: raw => sent.push(JSON.parse(raw)), ...fakeClock(), openMedia });
  beforeStart(session);
  const socket = session.start();
  socket.receive(JSON.stringify(helloOk()));
  const receive = (n, type, payload) => socket.receive(JSON.stringify(command(n, type, payload)));
  return { sent, receive, close: socket.close };
}

test('media failure returns stable failure and leaves device available', () => {
  let attempts = 0;
  const { sent, receive, close } = fixture(() => {
    if (++attempts === 1) throw new Error('failed');
    return { close() {} };
  });
  const dial = n => receive(n, 'call.dial', { callId: 'c', media: {} });
  dial(1);
  const ack = sent.at(-1);
  assert.equal(ack.type, 'ack');
  assert.equal(ack.payload.ok, false);
  assert.equal(ack.payload.error, 'CAPABILITY_UNSUPPORTED');
  dial(1);
  assert.deepEqual(sent.at(-1), ack);
  assert.equal(attempts, 1);
  dial(2);
  assert.equal(attempts, 2);
  assert.equal(sent.at(-2).payload.ok, true);
  assert.equal(sent.at(-1).payload.state, 'dialing');
  close();
});

test('failed answer leaves ringing call available for reject', () => {
  const { sent, receive, close } = fixture(() => { throw new Error('failed'); }, session => session.incoming('c'));
  receive(1, 'call.answer', { callId: 'c', media: {} });
  assert.equal(sent.at(-1).payload.ok, false);
  receive(2, 'call.reject', { callId: 'c' });
  assert.equal(sent.at(-2).payload.ok, true);
  assert.equal(sent.at(-1).payload.state, 'disconnected');
  close();
});
