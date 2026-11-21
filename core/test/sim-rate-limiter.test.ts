import {describe, expect, it} from 'vitest';
import {SimRateLimiter} from '../src/sms/state.js';

describe('SIM rate transitions', () => {
  it('rejects invalid finite rates without altering a bucket', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    now = 30000;
    for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
      expect(() => limiter.take('a', invalid)).toThrow('Invalid rate');
      expect(() => limiter.waitMs('a', invalid)).toThrow('Invalid rate');
    }
    expect(() => limiter.waitMs('a', 0.5)).toThrow('Invalid rate');
    expect(limiter.waitMs('a', 1)).toBe(30000);
    now = 60000;
    expect(limiter.take('a', 1)).toBe(true);
  });

  it('preserves a full initial burst and independent fixed-rate refill', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 2)).toBe(true);
    expect(limiter.take('a', 2)).toBe(true);
    expect(limiter.take('a', 2)).toBe(false);
    expect(limiter.take('b', 2)).toBe(true);
    expect(limiter.waitMs('a', 2)).toBe(30000);
    now = 30000;
    expect(limiter.take('a', 2)).toBe(true);
    expect(limiter.take('a', 2)).toBe(false);
    expect(limiter.take('b', 2)).toBe(true);
  });

  it('applies confirmed global changes to idle SIM buckets at observation time', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('b', 1)).toBe(true);
    now = 15000;
    limiter.setGlobalRate(2);
    now = 30000;
    expect(limiter.waitMs('a', 2)).toBe(7500);
    expect(limiter.waitMs('b', 2)).toBe(7500);
    now = 37500;
    expect(limiter.take('a', 2)).toBe(true);
    expect(limiter.take('b', 2)).toBe(true);
  });

  it('preserves finite accrual across globally unlimited settings and rejects invalid updates', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    now = 15000;
    limiter.setGlobalRate(null);
    for (const invalid of [0, -1, NaN, Infinity]) {
      expect(() => limiter.setGlobalRate(invalid)).toThrow('Invalid rate');
    }
    now = 30000;
    limiter.setGlobalRate(2);
    expect(limiter.waitMs('a', 2)).toBe(15000);
  });

  it('rejects an invalid global transition clock without modifying any bucket', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('b', 1)).toBe(true);
    now = NaN;
    expect(() => limiter.setGlobalRate(2)).toThrow('Invalid clock');
    now = 30000;
    expect(limiter.waitMs('a', 1)).toBe(30000);
    expect(limiter.waitMs('b', 1)).toBe(30000);
  });

  it('credits elapsed time at the old rate on increases and decreases', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('increase', 1)).toBe(true);
    now = 30000;
    expect(limiter.waitMs('increase', 2)).toBe(15000);
    now = 44999;
    expect(limiter.take('increase', 2)).toBe(false);
    now = 45000;
    expect(limiter.take('increase', 2)).toBe(true);

    now = 0;
    expect(limiter.take('decrease', 2)).toBe(true);
    expect(limiter.take('decrease', 2)).toBe(true);
    now = 15000;
    expect(limiter.waitMs('decrease', 1)).toBe(30000);
    now = 45000;
    expect(limiter.take('decrease', 1)).toBe(true);
  });

  it('settles a direct take at the old rate and old capacity', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    now = 30000;
    expect(limiter.take('a', 2)).toBe(false);
    now = 45000;
    expect(limiter.take('a', 2)).toBe(true);

    now = 0;
    expect(limiter.take('b', 1)).toBe(true);
    now = 120000;
    expect(limiter.take('b', 4)).toBe(true);
    expect(limiter.take('b', 4)).toBe(false);
  });

  it('clamps a smaller capacity and does not fill an enlarged bucket', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 4)).toBe(true);
    expect(limiter.take('a', 2)).toBe(true);
    expect(limiter.take('a', 2)).toBe(true);
    expect(limiter.take('a', 4)).toBe(false);
    now = 15000;
    expect(limiter.take('a', 4)).toBe(true);
    expect(limiter.take('a', 4)).toBe(false);
  });

  it('bypasses unlimited calls while retaining each finite bucket', () => {
    let now = 0;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('b', 1)).toBe(true);
    now = 15000;
    expect(limiter.take('a', null)).toBe(true);
    expect(limiter.take('a', null)).toBe(true);
    limiter.refund('a', null);
    now = 30000;
    expect(limiter.waitMs('a', 2)).toBe(15000);
    expect(limiter.waitMs('b', 1)).toBe(30000);
    expect(limiter.take('new', null)).toBe(true);
    expect(limiter.take('new', 2)).toBe(true);
    expect(limiter.take('new', 2)).toBe(true);
  });

  it('does not double credit after clock rollback, including the wait estimate', () => {
    let now = 10000;
    const limiter = new SimRateLimiter(() => now);
    expect(limiter.take('a', 1)).toBe(true);
    now = 0;
    expect(limiter.waitMs('a', 2)).toBe(40000);
    now = 10000;
    expect(limiter.take('a', 2)).toBe(false);
    now = 39999;
    expect(limiter.take('a', 2)).toBe(false);
    now = 40000;
    expect(limiter.take('a', 2)).toBe(true);
  });

  it('refunds a finite reservation against the currently observed capacity', () => {
    const limiter = new SimRateLimiter(() => 0);
    expect(limiter.take('a', 3)).toBe(true);
    expect(limiter.take('a', 3)).toBe(true);
    expect(limiter.take('a', 3)).toBe(true);
    expect(limiter.take('a', 1)).toBe(false);
    limiter.refund('a', 3);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('a', 1)).toBe(false);

    expect(limiter.take('b', 1)).toBe(true);
    expect(limiter.take('b', 3)).toBe(false);
    limiter.refund('b', 1);
    limiter.refund('b', 1);
    expect(limiter.take('b', 3)).toBe(true);
    expect(limiter.take('b', 3)).toBe(true);
    expect(limiter.take('b', 3)).toBe(false);
  });

  it('refunds only an existing finite bucket without changing another SIM', () => {
    const limiter = new SimRateLimiter(() => 0);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('b', 1)).toBe(true);
    limiter.refund('a', 1);
    expect(limiter.take('a', 1)).toBe(true);
    expect(limiter.take('b', 1)).toBe(false);
    limiter.refund('missing', 1);
    expect(limiter.take('missing', 1)).toBe(true);
  });
});
