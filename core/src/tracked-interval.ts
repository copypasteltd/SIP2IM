/** Runs independent jobs at most once concurrently each, and drains them on shutdown. */
export class TrackedInterval {
  private readonly pending = new Map<() => void | Promise<void>, Promise<void>>();
  private shutdownFailure: unknown;
  private hasShutdownFailure = false;
  private stopped = false;
  private stopping: Promise<void> | undefined;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(intervalMs: number, private readonly jobs: ReadonlyArray<() => void | Promise<void>>, private readonly report: (error: unknown) => void) {
    this.timer = setInterval(() => this.tick(), intervalMs);
  }

  private tick(): void {
    if (this.stopped) return;
    for (const job of this.jobs) {
      if (this.stopped) break;
      // Skip a missed tick for this job, without delaying independent jobs.
      if (this.pending.has(job)) continue;
      const tracked = Promise.resolve().then(() => {
        if (!this.stopped) return job();
      }).then(undefined, error => this.record(error));
      this.pending.set(job, tracked);
      void tracked.then(() => this.pending.delete(job));
    }
  }

  private record(error: unknown): void {
    if (this.stopped && !this.hasShutdownFailure) {
      this.shutdownFailure = error;
      this.hasShutdownFailure = true;
    }
    try { this.report(error); } catch (reportError) {
      if (this.stopped && !this.hasShutdownFailure) {
        this.shutdownFailure = reportError;
        this.hasShutdownFailure = true;
      }
    }
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopped = true;
      clearInterval(this.timer);
      this.stopping = (async () => {
        await Promise.all(this.pending.values());
        if (this.hasShutdownFailure) throw new AggregateError([this.shutdownFailure], 'recurring task failed during shutdown');
      })();
    }
    return this.stopping;
  }
}
