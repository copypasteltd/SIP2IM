import type { QueuedDevicePage } from './queue-repo.js';

const MAX_WAITING_DIRECT_REQUESTS = 256;

/** Keeps durable queue discovery independent of SMS command/ACK latency. */
export class SmsRateRuntime {
  private stopped = false;
  private uncertain = false;
  private epoch = 0;
  private rate?: { value: number | null };
  private inventoryAfter: string | null = null;
  private next: 'read' | 'inventory' | undefined;
  private running: Promise<void> | undefined;
  private readonly waiting = new Set<string>();
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ports: {
    readRate(): Promise<number | null>;
    queuedDevices(after: string | null): Promise<QueuedDevicePage>;
    setRate(rate: number | null | undefined): void;
    flush(device: string, rate: number | null): Promise<void>;
    report(error: unknown): void;
  }) {}

  /** Called synchronously after a confirmed settings change, or a write with an unknown outcome. */
  changed(rate: number | null | undefined): void {
    if (this.stopped || this.uncertain) return;
    const epoch = ++this.epoch;
    this.cancelRetry();
    if (rate === undefined) {
      // An ordinary read cannot prove that an uncertain settings COMMIT is done.
      // Suspend new sends until Core restarts under exclusive ownership.
      this.uncertain = true;
      this.next = undefined;
      this.waiting.clear();
      this.ports.setRate(undefined);
      return;
    }
    this.useRate(rate, epoch);
    if (!this.isCurrent(epoch)) return;
    this.next = 'inventory';
    void this.start();
  }

  /** A commit is known, but the new value was not returned (e.g. release failed). */
  invalidate(): void {
    if (this.stopped || this.uncertain) return;
    const epoch = ++this.epoch;
    this.cancelRetry();
    this.rate = undefined;
    this.ports.setRate(undefined);
    if (!this.isCurrent(epoch)) return;
    this.next = 'read';
    void this.start();
  }

  request(id: string): void {
    if (this.stopped || this.uncertain) return;
    if (this.rate) {
      this.dispatch(id, this.rate.value);
    } else {
      // These are only wake hints; periodic inventory still recovers overflow.
      if (this.waiting.size < MAX_WAITING_DIRECT_REQUESTS) this.waiting.add(id);
      if (!this.retry) void this.refresh();
    }
  }

  /** Startup and periodic recovery for committed tasks: at most one page per pass. */
  refresh(): Promise<void> {
    if (this.stopped || this.uncertain) return Promise.resolve();
    if (this.running) return this.running;
    this.cancelRetry();
    this.next = 'read';
    return this.start();
  }

  private isCurrent(epoch: number): boolean {
    return !this.stopped && !this.uncertain && epoch === this.epoch;
  }

  private useRate(rate: number | null, epoch: number): void {
    if (this.rate?.value === rate) return;
    this.ports.setRate(rate);
    if (this.isCurrent(epoch)) this.rate = { value: rate };
  }

  private dispatch(id: string, rate: number | null): void {
    // Dispatcher tracks its own flushes; settings, inventory and shutdown never
    // wait here for a command acknowledgement. Isolate failures per device.
    try { void this.ports.flush(id, rate).catch(error => this.report(error)); }
    catch (error) { this.report(error); }
  }

  private report(error: unknown): void {
    try { this.ports.report(error); } catch { /* reporting cannot stop scheduling */ }
  }

  private start(): Promise<void> {
    // Register before any port runs, including a port that calls stop().
    return this.running ??= Promise.resolve().then(() => this.run());
  }

  private async run(): Promise<void> {
    try {
      while (!this.stopped && !this.uncertain && this.next) {
        const mode = this.next;
        const epoch = this.epoch;
        this.next = undefined;
        try {
          if (mode === 'read') {
            const rate = await this.ports.readRate();
            if (!this.isCurrent(epoch)) continue;
            this.useRate(rate, epoch);
          }
          if (!this.isCurrent(epoch)) continue;
          const rate = this.rate!.value;
          const directlyRequested = new Set<string>();
          for (const id of this.waiting) {
            if (!this.isCurrent(epoch)) break;
            this.waiting.delete(id);
            directlyRequested.add(id);
            this.dispatch(id, rate);
          }
          if (!this.isCurrent(epoch)) continue;
          const page = await this.ports.queuedDevices(this.inventoryAfter);
          if (!this.isCurrent(epoch)) continue;
          for (const id of page.ids) {
            if (!this.isCurrent(epoch)) break;
            if (!directlyRequested.has(id)) this.dispatch(id, rate);
          }
          // Advance only after offering the current page's wake hints. Don't
          // await dispatch or its ACKs, and leave continuation to the next pass.
          if (this.isCurrent(epoch)) this.inventoryAfter = page.nextAfter;
        } catch (error) {
          this.report(error);
          if (this.isCurrent(epoch) && !this.retry) {
            this.retry = setTimeout(() => {
              this.retry = undefined;
              void this.refresh();
            }, 1000);
          }
        }
      }
    } finally {
      // No microtask gap between observing no follow-up and releasing ownership.
      this.running = undefined;
    }
  }

  private cancelRetry(): void {
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.next = undefined;
    this.waiting.clear();
    this.cancelRetry();
    await this.running;
  }
}
