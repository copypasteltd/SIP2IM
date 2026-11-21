import test from 'node:test';
import assert from 'node:assert/strict';
import { createSession } from './runner.mjs';
import { command, fakeClock, helloOk } from './control.fixture.mjs';

test('disconnect closes media and suppresses heartbeat until hello.ok', () => {
  const clock = fakeClock();
  const sent = [];
  let closed = 0;
  const session = createSession({ token: 'fixture', send: raw => sent.push(JSON.parse(raw)), ...clock,
    openMedia: () => ({ close() { closed++; } }),
  });
  const first = session.start();
  first.receive(JSON.stringify(helloOk()));
  first.receive(JSON.stringify(command(1, 'call.dial', { callId: 'c', media: {} })));
  first.close();
  const count = sent.length;
  clock.advance(30_000);
  first.heartbeat();
  assert.equal(sent.length, count);
  assert.equal(closed, 1);
  const second = session.start();
  clock.advance(30_000);
  second.heartbeat();
  assert.equal(sent.length, count + 1);
  second.receive(JSON.stringify(helloOk()));
  clock.advance(30_000);
  assert.equal(sent.at(-1).type, 'heartbeat');
  second.close();
});
