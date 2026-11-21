export const startTime = 1_700_000_000_123;
export const id = (prefix, value = 1) => prefix + '_' + String(value).padStart(26, '0');
export const command = (number, type, payload) => ({ v: 1, id: id('cmd', number), ts: startTime, type, payload });
export const helloOk = (heartbeatSec = 30, locale = 'en', deviceId = id('dev')) => command(0, 'hello.ok', {
  deviceId, serverTime: startTime, config: { heartbeatSec, locale },
});

export function fakeClock(start = startTime) {
  let now = start, handle = 0;
  const intervals = new Map();
  return {
    intervals,
    now: () => now,
    setIntervalFn(callback, delay) {
      const timer = { callback, delay, due: now + delay };
      intervals.set(++handle, timer);
      return handle;
    },
    clearIntervalFn(key) { intervals.delete(key); },
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const timer = [...intervals.values()].filter(timer => timer.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!timer) break;
        now = timer.due;
        timer.due += timer.delay;
        timer.callback();
      }
      now = end;
    },
  };
}
