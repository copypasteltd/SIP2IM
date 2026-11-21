import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {makeDeviceEventProducer, type DeviceEventEnvelope} from '../src/devices/event-producer.js';
import {DeviceEvents} from '../src/devices/events.js';
import {DeviceSessions} from '../src/ws-device/session.js';
it('wakes the outbox for inserted and duplicate incoming events without direct publishing',async()=>{const incomingSms=vi.fn();let calls=0;const producer=makeDeviceEventProducer({handle:async()=>++calls===1?'inserted':'duplicate',incomingSms});const event={id:'evt',type:'sms.received',ts:1,payload:{}};expect(await producer('dev',event)).toBe(true);expect(await producer('dev',event)).toBe(true);expect(incomingSms).toHaveBeenCalledTimes(2);});

const snapshot = {
  id: 'snapshot', type: 'status.snapshot', ts: 1,
  payload: {sims: [], simsAuthoritative: true, capabilityLevel: 'L1', probes: {}, permissions: []},
};

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return {promise, release};
}

it('requests a recheck after commit even for a history-only snapshot', async () => {
  const committing = gate();
  const commit = gate();
  const query = vi.fn(async (sql: string) => {
    if (sql === 'COMMIT') {
      committing.release();
      await commit.promise;
    }
    // A newer snapshot already owns the current projection.
    const matched = sql.startsWith('SELECT id FROM device WHERE') ||
      sql.startsWith('INSERT INTO device_event') || sql.startsWith('SELECT 1 FROM device_event');
    return {command: sql, rowCount: matched ? 1 : 0, rows: matched ? [{}] : []};
  });
  const pool = {connect: async () => ({query, release: vi.fn()})} as unknown as pg.Pool;
  const events = new DeviceEvents(pool);
  const snapshotCommitted = vi.fn();
  const producer = makeDeviceEventProducer({handle: (id, event) => events.handle(id, event), snapshotCommitted});

  const ack = producer('dev', snapshot);
  await committing.promise;
  try {
    expect(snapshotCommitted).not.toHaveBeenCalled();
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      expect.stringMatching(/^SELECT id FROM device WHERE/),
      expect.stringMatching(/^INSERT INTO device_event/),
      expect.stringMatching(/^SELECT 1 WHERE/),
      expect.stringMatching(/^SELECT 1 FROM device_event/),
      'COMMIT',
    ]);
  } finally { commit.release(); }
  await expect(ack).resolves.toBe(true);
  expect(snapshotCommitted.mock.calls).toEqual([['dev']]);
});

it.each([['duplicate', true], ['rejected', false], ['quarantined', false]] as const)(
  'preserves the ACK decision and skips the wake for a %s snapshot', async (outcome, accepted) => {
    const snapshotCommitted = vi.fn();
    const producer = makeDeviceEventProducer({handle: async () => outcome, snapshotCommitted});
    await expect(producer('dev', snapshot)).resolves.toBe(accepted);
    expect(snapshotCommitted).not.toHaveBeenCalled();
  },
);

it.each(['sms.received', 'sms.result', 'call.incoming', 'call.state'])(
  'skips the snapshot wake for an inserted %s event', async type => {
    const snapshotCommitted = vi.fn();
    const producer = makeDeviceEventProducer({handle: async () => 'inserted', snapshotCommitted});
    await expect(producer('dev', {id: 'event', type, ts: 1, payload: {taskId: 'task'}})).resolves.toBe(true);
    expect(snapshotCommitted).not.toHaveBeenCalled();
  },
);

it('allows the snapshot wake port to be omitted', async () => {
  const producer = makeDeviceEventProducer({handle: async () => 'inserted'});
  await expect(producer('dev', snapshot)).resolves.toBe(true);
});

it.each([
  ['synchronous', () => { throw new Error('wake failed'); }],
  ['asynchronous', async () => { throw new Error('wake failed'); }],
] as const)('ACKs a committed snapshot despite a %s wake failure', async (_kind, wake) => {
  const snapshotCommitted = vi.fn(wake);
  const producer = makeDeviceEventProducer({handle: async () => 'inserted', snapshotCommitted});
  await expect(producer('dev', snapshot)).resolves.toBe(true);
  expect(snapshotCommitted).toHaveBeenCalledExactlyOnceWith('dev');
});

it('allows the wiring to wake only from the current attachment at commit', async () => {
  const deviceId = 'dev_00000000000000000000000001';
  const oldSnapshotId = 'evt_00000000000000000000000002';
  const currentSnapshotId = 'evt_00000000000000000000000003';
  const admitted = gate();
  const oldCommit = gate();
  const request = vi.fn();
  const heartbeat = vi.fn(async () => {});
  const sessions = new DeviceSessions({
    authenticate: async () => ({id: deviceId, enabled: true}),
    heartbeat,
    heartbeatSec: 30,
    locale: 'en',
    onEvent: (id, event, context) => makeDeviceEventProducer({
      handle: async (_id, envelope) => {
        if (envelope.id === oldSnapshotId) {
          admitted.release();
          await oldCommit.promise;
        }
        return 'inserted';
      },
      snapshotCommitted: id => { if (context.isCurrent()) request(id); },
    })(id, event as DeviceEventEnvelope),
  });
  const hello = JSON.stringify({
    v: 1, id: 'evt_00000000000000000000000001', type: 'hello', ts: 1,
    payload: {token: 'fixture', apkVersion: '1', apkCode: 1, protocol: 1, manufacturer: 'fixture', model: 'fixture', apiLevel: 19, locale: 'en'},
  });
  const probe = {result: 'untested', probedAt: 1, detail: null};
  const frame = (id: string) => JSON.stringify({
    ...snapshot, v: 1, id,
    payload: {...snapshot.payload, probes: {
      smsSend: probe, smsReceive: probe, dial: probe, answer: probe, hangup: probe,
      dtmf: probe, downlink: probe, uplink: probe, earlyMedia: probe,
    }},
  });
  const oldSocket = {send: vi.fn<(data: string) => void>(), close: vi.fn()};
  const currentSocket = {send: vi.fn<(data: string) => void>(), close: vi.fn()};
  const oldSession = sessions.open(oldSocket);
  const currentSession = sessions.open(currentSocket);
  try {
    await oldSession.message(hello);
    const inFlight = oldSession.message(frame(oldSnapshotId));
    await admitted.promise;
    const replacement = currentSession.message(hello);
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(oldSocket.close).toHaveBeenCalledWith(4009);
    oldCommit.release();
    await Promise.all([inFlight, replacement]);
    expect(oldSocket.send).toHaveBeenCalledOnce();
    expect(request).not.toHaveBeenCalled();

    await currentSession.message(frame(currentSnapshotId));
    expect(request).toHaveBeenCalledExactlyOnceWith(deviceId);
    expect(heartbeat).not.toHaveBeenCalled();
    expect(JSON.parse(currentSocket.send.mock.calls[1]![0])).toMatchObject({
      type: 'ack', payload: {refId: currentSnapshotId, ok: true, error: null},
    });
  } finally {
    oldCommit.release();
    await sessions.stop();
  }
});

it('preserves a persistence error and skips the wake', async () => {
  const failure = new Error('commit outcome unknown');
  const snapshotCommitted = vi.fn();
  const producer = makeDeviceEventProducer({handle: async () => { throw failure; }, snapshotCommitted});
  await expect(producer('dev', snapshot)).rejects.toBe(failure);
  expect(snapshotCommitted).not.toHaveBeenCalled();
});
