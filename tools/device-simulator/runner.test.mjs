import test from 'node:test';
import assert from 'node:assert/strict';
import { bindDevice, createSession } from './runner.mjs';
import { command, fakeClock, helloOk, id } from './control.fixture.mjs';

test('binding sends correct payload without network', async () => {
  let request;
  const result = await bindDevice('ws://example.test:123/ws/device', '012345', async (url, options) => {
    request = { url: String(url), options };
    return { ok: true, json: async () => ({ data: { deviceId: id('dev'), token: 'fixture' } }) };
  });
  assert.equal(request.url, 'http://example.test:123/api/device/bind');
  assert.equal(JSON.parse(request.options.body).code, '012345');
  assert.equal(result.deviceId, id('dev'));
});

test('authentication gates snapshot and retained events replay until ack', () => {
  const clock = fakeClock();
  const sent = [];
  const session = createSession({ token: 'fixture', deviceId: id('dev'), send: raw => sent.push(JSON.parse(raw)), ...clock });
  session.sms('+12025550123', 'hello');
  const first = session.start();
  assert.deepEqual(sent.map(x => x.type), ['hello']);
  first.receive(JSON.stringify(helloOk()));
  assert.deepEqual(sent.map(x => x.type), ['hello', 'status.snapshot', 'sms.received']);
  const event = sent[2];
  const second = session.start();
  second.receive(JSON.stringify(helloOk()));
  assert.deepEqual(sent.at(-1), event);
  clock.advance(20);
  const ack = JSON.stringify(command(1, 'ack', { ok: true, refId: event.id, error: null }));
  first.receive(ack);
  assert.equal(session.report().pending, 1);
  second.receive(ack);
  assert.deepEqual(session.report().latenciesMs, [20]);
  second.close();
});
