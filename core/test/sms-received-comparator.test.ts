import {describe, expect, it} from 'vitest';
import {parseDeviceMessage} from '@voipgw/protocol';
import {compareParsedSmsReceived as compare} from '../src/devices/sms-received-comparator.js';

const deviceId = 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const id = 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAV';
const sample = () => ({deviceId, v: 1, type: 'sms.received', id, ts: 12, payload: {
  subId: null, slot: 0, from: '123', fromKind: 'short', body: 'hello', receivedAt: 10, parts: 1,
}});

describe('isolated parsed SMS event comparison', () => {
  it('accepts protocol-parsed reordered objects, including negative zero', () => {
    const a = sample();
    const parsed = parseDeviceMessage({payload: {parts: 1, body: 'hello', receivedAt: 10, fromKind: 'short', from: '123', slot: -0, subId: null}, ts: 12, id, type: 'sms.received', v: 1}, 'event');
    expect(compare(a, {deviceId, ...parsed})).toBe('equal');
  });
  it('preserves exact UTF-16 code units including NUL and lone surrogates', () => {
    for (const text of ['', '\0', 'x\0y', '\ud800', '\udfff', '\ud83d\ude00', '\\u0000']) {
      const a = sample(); a.payload.body = text;
      const b = sample(); b.payload.body = text;
      expect(compare(a, b)).toBe('equal');
      b.payload.body += '\0';
      expect(compare(a, b)).toBe('different');
      expect(compare(b, a)).toBe('different');
    }
    const a = sample(), b = sample(); a.payload.from = '\ud800'; b.payload.from = '\ufffd';
    expect(compare(a, b)).toBe('different');
  });
  it('compares all payload and identity fields rather than declaring false duplicates', () => {
    const a = sample();
    const variants = [
      {...a, deviceId: 'dev_01ARZ3NDEKTSV4RRFFQ69G5FAW'},
      {...a, id: 'evt_01ARZ3NDEKTSV4RRFFQ69G5FAW'}, {...a, ts: 13},
      ...Object.entries({subId: 1, slot: null, from: '124', fromKind: 'unknown', body: 'hello!', receivedAt: 11, parts: 2})
        .map(([key, value]) => ({...a, payload: {...a.payload, [key]: value}})),
    ];
    for (const variant of variants) { expect(compare(a, variant)).toBe('different'); expect(compare(variant, a)).toBe('different'); }
  });
  it('rejects unsafe integers even if the protocol parser accepts them', () => {
    const a = sample();
    const parsed = parseDeviceMessage({...a, payload: {...a.payload, subId: 2 ** 53}}, 'event');
    expect(compare({deviceId, ...parsed}, {deviceId, ...parsed})).toBe('invalid');
  });
  it('handles numeric boundaries while rejecting unsafe and invalid values', () => {
    const a = sample();
    const b = {...a, ts: 8_640_000_000_000_000, payload: {...a.payload, receivedAt: 8_640_000_000_000_000, subId: Number.MIN_SAFE_INTEGER, slot: Number.MAX_SAFE_INTEGER, parts: Number.MAX_SAFE_INTEGER}};
    expect(compare(b,b)).toBe('equal');
    for (const [key, value] of [['ts', -1], ['ts', 8_640_000_000_000_001], ['ts', NaN], ['ts', Infinity], ['ts', 1.5]] as const)
      expect(compare({...a, [key]: value}, {...a, [key]: value})).toBe('invalid');
    for (const [key,value] of [['subId', Number.MAX_SAFE_INTEGER + 1], ['subId', Number.MIN_SAFE_INTEGER - 1], ['slot', -1], ['slot', Number.MAX_SAFE_INTEGER + 1], ['receivedAt', 8_640_000_000_000_001], ['parts', 0], ['parts', 1.5], ['parts', Infinity], ['parts', Number.MAX_SAFE_INTEGER + 1]] as const) {
      const bad = {...a, payload: {...a.payload, [key]: value}};
      expect(compare(bad,bad)).toBe('invalid'); expect(compare(a,bad)).toBe('invalid');
    }
  });
  it('rejects getters without invoking them and throwing proxy traps', () => {
    const getter = sample();
    Object.defineProperty(getter.payload, 'body', {enumerable: true, get() { throw new Error('must not run'); }});
    expect(compare(getter, getter)).toBe('invalid');
    const proxy = new Proxy(sample(), {ownKeys() { throw new Error('trap'); }});
    expect(compare(proxy, proxy)).toBe('invalid');
    const revoked = Proxy.revocable(sample(), {}); revoked.revoke();
    expect(compare(revoked.proxy, sample())).toBe('invalid');
  });
  it('rejects malformed, wrong-type, missing and unexpected fields even when identical', () => {
    const a = sample();
    const bad = [null, {}, {...a, v: 2}, {...a, type: 'sms.result'}, {...a, id: 'bad'}, {...a, deviceId: 'bad'}, {...a, extra: 1},
      {...a, payload: null}, {...a, payload: {...a.payload, extra: 1}}, {...a, payload: {...a.payload, body: 1}},
      {...a, payload: {...a.payload, fromKind: 'number'}}, {...a, payload: {...a.payload, subId: '0'}},
      {...a, payload: (({body: _body, ...rest}) => rest)(a.payload)}];
    for (const value of bad) { expect(compare(value,value)).toBe('invalid'); expect(compare(a,value)).toBe('invalid'); }
  });
});
