/** Keeps durable queue discovery independent of SMS command/ACK latency. */
export class SmsRateRuntime {
  private stopped = false;
  private uncertain = false;
  private epoch = 0;
  private rate?: { value: number | null };
  private next: 'read' | 'inventory' | undefined;
  private running: Promise<void> | undefined;
  private readonly waiting = new Set<string>();
  private retry: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ports: {
    readRate(): Promise<number | null>;
    queuedDevices(): Promise<string[]>;
    setRate(rate: number | null | undefined): void;
    flush(device: string, rate: number | null): Promise<void>;
    report(error: unknown): void;
  }) {}

  /** Called synchronously after a confirmed settings change, or a write with an unknown outcome. */
  changed(rate: number | null | undefined): void {
    if (this.stopped || this.uncertain) return;
    ++this.epoch;
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
    this.useRate(rate);
    this.next = 'inventory';
    void this.start();
  }

  /** A commit is known, but the new value was not returned (e.g. release failed). */
  invalidate(): void {
    if (this.stopped || this.uncertain) return;
    ++this.epoch;
    this.cancelRetry();
    this.rate = undefined;
    this.ports.setRate(undefined);
    this.next = 'read';
    void this.start();
  }

  request(id: string): void {
    if (this.stopped || this.uncertain) return;
    if (this.rate) {
      this.dispatch(id, this.rate.value);
    } else {
      this.waiting.add(id);
      if (!this.retry) void this.refresh();
    }
  }

  /** Startup and periodic recovery for committed tasks that missed their direct wake. */
  refresh(): Promise<void> {
    if (this.stopped || this.uncertain) return Promise.resolve();
    if (this.running) return this.running;
    this.cancelRetry();
    this.next = 'read';
    return this.start();
  }

  private useRate(rate: number | null): void {
    if (this.rate?.value === rate) return;
    this.ports.setRate(rate);
    this.rate = { value: rate };
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
            if (this.stopped || this.uncertain || epoch !== this.epoch) continue;
            this.useRate(rate);
          }
          const rate = this.rate!.value;
          const directlyRequested = new Set(this.waiting);
          this.waiting.clear();
          for (const id of directlyRequested) {
            if (this.stopped || this.uncertain || epoch !== this.epoch) break;
            this.dispatch(id, rate);
          }
          if (this.stopped || this.uncertain || epoch !== this.epoch) continue;
          const ids = await this.ports.queuedDevices();
          for (const id of ids) {
            if (this.stopped || this.uncertain || epoch !== this.epoch) break;
            if (!directlyRequested.has(id)) this.dispatch(id, rate);
          }
        } catch (error) {
          this.report(error);
          if (!this.stopped && !this.uncertain && epoch === this.epoch && !this.retry) {
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
