import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './runner.mjs';
import { command, fakeClock, helloOk } from './control.fixture.mjs';

test('only accepted first command opens media and hangup closes it once', () => {
  let opens = 0, closes = 0;
  const sent = [];
  const session = createSession({ token: 'fixture', send: raw => sent.push(JSON.parse(raw)), ...fakeClock(),
    openMedia: () => { opens++; return { close: () => closes++ }; },
  });
  const socket = session.start();
  socket.receive(JSON.stringify(helloOk()));
  const receive = (n, type, payload) => socket.receive(JSON.stringify(command(n, type, payload)));
  receive(1, 'call.dial', {});
  assert.equal(opens, 0);
  const dial = { callId: 'c', media: { path: 'fixture' } };
  receive(2, 'call.dial', dial);
  receive(2, 'call.dial', dial);
  receive(3, 'call.dial', { callId: 'd', media: {} });
  assert.equal(opens, 1);
  receive(4, 'call.hangup', { callId: 'c' });
  receive(4, 'call.hangup', { callId: 'c' });
  assert.equal(closes, 1);
  assert.ok(!sent.some(x => x.type === 'call.state' && x.payload.state === 'active'));
  socket.close();
});
