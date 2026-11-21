import { SimRateLimiter } from './state.js';

export interface QueuedSms {
  id: string;
  simId: string;
  deviceId: string;
  createdAt: number;
  expired?: boolean;
  /** This is the last row of a bounded SIM page with more work behind it. */
  moreForSim?: boolean;
}
export type SmsCommandAck = { ok: boolean; error: string | null };
type Rate = number | null;
type PendingWake = { resolve(): void; reject(error: unknown): void };

export const SMS_ACTIVE_DEVICES = 4;
export const SMS_WAITING_WAKES = 256;
const DEVICE_TURN_MS = 2_000;

interface CommonDispatchPorts {
  queued(deviceId: string): Promise<QueuedSms[]>;
  canCommand(deviceId: string): Promise<boolean>;
  simState(simId: string, deviceId: string): Promise<'ready' | 'unknown' | 'unavailable'>;
  /** Optional legacy lookup. Managed Core pushes confirmed changes with setRate(). */
  currentRate?(): Promise<Rate>;
}

/** Legacy in-memory dispatcher ports, retained for isolated callers and fakes. */
export interface SmsDispatchPorts extends CommonDispatchPorts {
  mark(id: string, from: 'queued' | 'dispatched', to: 'dispatched' | 'accepted' | 'failed' | 'unknown', error: string | null, task?: QueuedSms): Promise<boolean>;
  send(task: QueuedSms): Promise<SmsCommandAck>;
  prepare?: never;
}

export interface PreparedSmsDispatch {
  claim(): Promise<boolean>;
  /** Only for a transport that settles its own bounded ACK window. */
  ackDeadline?: 'transport';
  send(): Promise<SmsCommandAck>;
  acknowledge(ack: SmsCommandAck): Promise<void>;
  markUnknown(): Promise<void>;
}

export interface DurableSmsDispatchPorts extends CommonDispatchPorts {
  mark(id: string, from: 'queued', to: 'failed', error: string | null, task?: QueuedSms): Promise<boolean>;
  prepare(task: QueuedSms): PreparedSmsDispatch | null;
  send?: never;
}

/** Each SIM visits once per round; oldest tasks still win within their own SIM. */
function* fairOrder(tasks: QueuedSms[], afterSim?: string): Iterable<QueuedSms> {
  const sims = new Map<string, QueuedSms[]>();
  for (const task of tasks.slice().sort((a, b) => a.createdAt - b.createdAt)) {
    const sim = sims.get(task.simId);
    if (sim) sim.push(task);
    else sims.set(task.simId, [task]);
  }
  let next = [...sims.values()];
  if (afterSim !== undefined) {
    // A yielded turn may have consumed its old queue head or lost a SIM.
    // Rotate by SIM ID, not by a shifting head timestamp or array offset.
    const ids = [...sims.keys()].sort();
    const start = ids.findIndex(id => id > afterSim);
    const ordered = start < 0 ? ids : [...ids.slice(start), ...ids.slice(0, start)];
    next = ordered.map(id => sims.get(id)!);
  }
  for (let index = 0; next.length; index++) {
    const current = next;
    next = [];
    for (const tasks of current) {
      yield tasks[index]!;
      if (index + 1 < tasks.length) next.push(tasks);
    }
  }
}

export class SmsDispatcher {
  private readonly running = new Set<string>();
  private readonly waiting = new Map<string, PendingWake>();
  private readonly simAfter = new Map<string, string>();
  private readonly dirty = new Set<string>();
  private readonly rates = new Map<string, Rate>();
  private globalRate?: { value: Rate | undefined };
  private pauseVersion = 0;
  private readonly wakeups = new Map<string, {timer: ReturnType<typeof setTimeout>; deadline: number}>();
  private readonly wakeVersions = new Map<string, object>();
  private readonly active = new Set<Promise<void>>();
  private readonly sends = new Set<Promise<unknown>>();
  private readonly settlements = new Map<string, () => Promise<void>>();
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(private readonly ports: SmsDispatchPorts | DurableSmsDispatchPorts, private readonly limiter: SimRateLimiter, private readonly now: () => number = () => performance.now()) {}

  /** undefined forbids transmission; unlike null, it is not an unlimited rate. */
  setRate(rate: Rate | undefined): void {
    if (this.stopped || (this.globalRate && this.globalRate.value === rate)) return;
    if (rate !== undefined) this.limiter.setGlobalRate(rate);
    else this.pauseVersion++;
    this.globalRate = { value: rate };
    if (rate === undefined) this.releaseWaiting(id => !this.settlements.has(id));
    for (const id of [...this.wakeups.keys()]) {
      this.cancelWakeup(id);
      if (rate !== undefined || this.settlements.has(id)) this.schedule(id, rate ?? null, 1);
    }
  }

  private get paused(): boolean {
    return this.globalRate !== undefined && this.globalRate.value === undefined;
  }

  // Admission closes synchronously. Drain work, including underlying sends
  // whose acknowledgement timeout has already elapsed.
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.stopped = true;
    for (const {timer} of this.wakeups.values()) clearTimeout(timer);
    this.wakeups.clear();
    this.simAfter.clear();
    this.releaseWaiting(() => true);
    this.stopping = (async () => {
      await Promise.allSettled([...this.active]);
      await Promise.allSettled([...this.sends]);
    })();
    return this.stopping;
  }

  private cancelWakeup(deviceId: string): void {
    const wakeup = this.wakeups.get(deviceId);
    if (wakeup) clearTimeout(wakeup.timer);
    this.wakeups.delete(deviceId);
  }

  private schedule(deviceId: string, rate: Rate, wait: number): void {
    if (this.stopped || (this.paused && !this.settlements.has(deviceId))) return;
    // Node clamps out-of-range delays to 1ms, which otherwise causes a hot loop.
    const delay = Math.min(2_147_483_647, Math.max(1, wait));
    const deadline = this.now() + delay;
    const existing = this.wakeups.get(deviceId);
    if (existing && existing.deadline <= deadline) return;
    this.cancelWakeup(deviceId);
    const timer = setTimeout(() => {
      if (this.wakeups.get(deviceId)?.timer !== timer) return;
      this.wakeups.delete(deviceId);
      const version = {};
      this.wakeVersions.set(deviceId, version);
      // Register before invoking a port, which may synchronously call stop().
      const work = Promise.resolve().then(async () => {
        try {
          if (this.stopped || this.wakeVersions.get(deviceId) !== version) return;
          const current = this.globalRate ? this.globalRate.value ?? null
            : this.ports.currentRate ? await this.ports.currentRate() : rate;
          if (!this.stopped && this.wakeVersions.get(deviceId) === version) {
            await this.flush(deviceId, current);
          }
        } catch {
          // flush retries its own failure; only a current lookup failure needs this retry.
          if (this.wakeVersions.get(deviceId) === version) this.schedule(deviceId, rate, 1000);
        } finally {
          if (this.wakeVersions.get(deviceId) === version) this.wakeVersions.delete(deviceId);
        }
      });
      this.active.add(work);
      void work.then(() => this.active.delete(work), () => this.active.delete(work));
    }, delay);
    this.wakeups.set(deviceId, {timer, deadline});
  }

  flush(deviceId: string, rate: Rate): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.wakeVersions.delete(deviceId);
    if (this.paused && !this.settlements.has(deviceId)) return Promise.resolve();
    if (this.running.has(deviceId)) {
      this.rates.set(deviceId, rate);
      this.dirty.add(deviceId);
      return Promise.resolve();
    }
    if (this.waiting.has(deviceId)) {
      this.rates.set(deviceId, rate);
      return Promise.resolve();
    }
    // Wakeups are hints; the periodic inventory can rediscover a durable task.
    // Settlement is different: it may have no queued task left to rediscover.
    if (this.waiting.size >= SMS_WAITING_WAKES && !this.settlements.has(deviceId)) return Promise.resolve();
    this.rates.set(deviceId, rate);
    const completion = new Promise<void>((resolve, reject) => this.waiting.set(deviceId, { resolve, reject }));
    this.admit();
    return completion;
  }

  private releaseWaiting(release: (id: string) => boolean): void {
    for (const [id, wake] of this.waiting) {
      if (!release(id)) continue;
      this.waiting.delete(id);
      this.rates.delete(id);
      wake.resolve();
    }
  }

  private admit(): void {
    while (!this.stopped && this.running.size < SMS_ACTIVE_DEVICES) {
      const item = this.waiting.entries().next().value;
      if (!item) break;
      const [id, wake] = item;
      this.waiting.delete(id);
      if (this.paused && !this.settlements.has(id)) {
        this.rates.delete(id);
        wake.resolve();
        continue;
      }
      const rate = this.rates.get(id) ?? null;
      this.running.add(id);
      // Register before a port can synchronously invoke stop().
      const work = Promise.resolve().then(() => this.run(id, rate));
      this.active.add(work);
      void work.then(() => {
        this.active.delete(work);
        wake.resolve();
      }, error => {
        this.active.delete(work);
        wake.reject(error);
      });
    }
  }

  private rateFor(deviceId: string, fallback: Rate): Rate {
    if (this.globalRate) return this.globalRate.value ?? null;
    return this.rates.has(deviceId) ? this.rates.get(deviceId)! : fallback;
  }

  private async waitForAck(send: () => Promise<SmsCommandAck>, transportDeadline = false): Promise<SmsCommandAck> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const sent = send();
      this.sends.add(sent);
      void sent.then(() => this.sends.delete(sent), () => this.sends.delete(sent));
      if (transportDeadline) return await sent;
      const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 10_000); });
      return await Promise.race([sent, deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private async settle(deviceId: string): Promise<void> {
    const work = this.settlements.get(deviceId);
    if (!work) return;
    await work();
    this.settlements.delete(deviceId);
  }

  private async run(deviceId: string, fallback: Rate): Promise<void> {
    const deadline = this.now() + DEVICE_TURN_MS;
    const shouldYield = () => this.waiting.size > 0 && this.now() >= deadline;
    let lastConsidered: string | undefined;
    const deferTurn = () => {
      if (!this.stopped && !this.paused && lastConsidered !== undefined) {
        this.simAfter.delete(deviceId);
        this.simAfter.set(deviceId, lastConsidered);
        // Fairness hints are not durable task state and must stay bounded.
        if (this.simAfter.size > SMS_WAITING_WAKES) this.simAfter.delete(this.simAfter.keys().next().value!);
      }
      this.schedule(deviceId, this.rateFor(deviceId, fallback), 1);
    };
    try {
      // Coalesce a direct wake while busy, but yield if wakes keep arriving.
      for (let pass = 0; pass < 2 && !this.stopped; pass++) {
        if (pass > 0 && shouldYield()) { deferTurn(); return; }
        this.dirty.delete(deviceId);
        // Recover persistence, including a claim that may have committed
        // despite throwing, before admitting queued work. Never send in recovery.
        await this.settle(deviceId);
        if (this.stopped || this.paused) break;
        const tasks = await this.ports.queued(deviceId);
        this.cancelWakeup(deviceId);
        let more = false;
        const blocked = new Set<string>();
        let considered = false;
        for (const task of fairOrder(tasks, this.simAfter.get(deviceId))) {
          if (this.stopped || this.paused) break;
          if (blocked.has(task.simId)) continue;
          // Finish an admitted task, then give other devices a slot before
          // starting another slow claim or waiting for another ACK.
          if (considered && shouldYield()) { deferTurn(); return; }
          considered = true;
          lastConsidered = task.simId;
          if (task.expired) {
            if (await this.ports.mark(task.id, 'queued', 'failed', 'DEVICE_OFFLINE')) more ||= !!task.moreForSim;
            else blocked.add(task.simId);
            continue;
          }
          if (!await this.ports.canCommand(deviceId) || this.stopped || this.paused) break;
          const simState = await this.ports.simState(task.simId, deviceId);
          if (this.stopped || this.paused) break;
          if (simState === 'unknown') { blocked.add(task.simId); continue; }
          if (simState === 'unavailable') {
            if (await this.ports.mark(task.id, 'queued', 'failed', 'SIM_NOT_READY', task)) more ||= !!task.moreForSim;
            else blocked.add(task.simId);
            continue;
          }
          const rate = this.rateFor(deviceId, fallback);
          if (!this.limiter.take(task.simId, rate)) {
            blocked.add(task.simId);
            if (rate !== null) this.schedule(deviceId, rate, this.limiter.waitMs(task.simId, rate));
            continue;
          }
          const processed = this.ports.prepare
            ? await this.durableSend(deviceId, this.ports.prepare(task))
            : await this.legacySend(this.ports, task);
          if (processed) more ||= !!task.moreForSim;
          else {
            this.limiter.refund(task.simId, rate);
            blocked.add(task.simId);
          }
        }
        this.simAfter.delete(deviceId);
        if (more) this.schedule(deviceId, this.rateFor(deviceId, fallback), 1);
        if (!this.dirty.has(deviceId)) break;
      }
      if (this.dirty.has(deviceId)) this.schedule(deviceId, this.rateFor(deviceId, fallback), 1);
    } catch (error) {
      this.schedule(deviceId, this.rateFor(deviceId, fallback), 1000);
      throw error;
    } finally {
      this.running.delete(deviceId);
      this.dirty.delete(deviceId);
      this.rates.delete(deviceId);
      this.admit();
    }
  }

  private async durableSend(deviceId: string, attempt: PreparedSmsDispatch | null): Promise<boolean> {
    if (!attempt || this.stopped || this.paused) return false;
    const pauseVersion = this.pauseVersion;
    try {
      if (!await attempt.claim()) return false;
    } catch (error) {
      this.settlements.set(deviceId, () => attempt.markUnknown());
      throw error;
    }
    let ack: SmsCommandAck | undefined;
    if (!this.stopped && !this.paused && this.pauseVersion === pauseVersion) {
      // Confirmed changes affect new reservations. A pause fences this claim
      // even if the new setting is successfully reloaded before it returns.
      try { ack = await this.waitForAck(() => attempt.send(), attempt.ackDeadline === 'transport'); }
      catch { /* A transport error cannot establish what the device did. */ }
    }
    const observed = ack;
    this.settlements.set(deviceId, observed ? () => attempt.acknowledge(observed) : () => attempt.markUnknown());
    await this.settle(deviceId);
    return true;
  }

  private async legacySend(ports: SmsDispatchPorts, task: QueuedSms): Promise<boolean> {
    const pauseVersion = this.pauseVersion;
    if (!await ports.mark(task.id, 'queued', 'dispatched', null, task)) return false;
    let ack: SmsCommandAck | undefined;
    if (!this.stopped && !this.paused && this.pauseVersion === pauseVersion) {
      try { ack = await this.waitForAck(() => ports.send(task)); }
      catch { /* As in the durable path, do not retransmit. */ }
    }
    // A failed ACK write must not be replaced with a generic unknown write.
    if (ack) await ports.mark(task.id, 'dispatched', ack.ok ? 'accepted' : 'failed', ack.error);
    else await ports.mark(task.id, 'dispatched', 'unknown', null);
    return true;
  }
}
