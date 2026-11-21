export type Cleanup = () => void | Promise<void>;

/** Start every independent drain, and report all failures after they settle. */
export async function drainAll(drains: readonly Cleanup[]): Promise<void> {
  const results = await Promise.allSettled(drains.map(drain => Promise.resolve().then(drain)));
  const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
  if (errors.length) throw new AggregateError(errors, 'drain failed');
}

interface CleanupOptions {
  /** A failure means resources guarded by requiresCriticalSuccess must remain open. */
  critical?: boolean;
  /** Skip this cleanup if any earlier critical cleanup failed. */
  requiresCriticalSuccess?: boolean;
}

/** Owns acquired resources in reverse acquisition order. */
export class Lifecycle {
  private readonly cleanups: Array<{ cleanup: Cleanup; options: CleanupOptions }> = [];
  private closing: Promise<void> | undefined;

  defer(cleanup: Cleanup, options: CleanupOptions = {}): void {
    if (this.closing) throw new Error('lifecycle already closing');
    this.cleanups.push({ cleanup, options: { ...options } });
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = Promise.resolve().then(() => this.closeAll());
    return this.closing;
  }

  private async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    let criticalFailed = false;
    while (this.cleanups.length) {
      const { cleanup, options } = this.cleanups.pop()!;
      if (options.requiresCriticalSuccess && criticalFailed) continue;
      try { await cleanup(); } catch (error) {
        errors.push(error);
        if (options.critical) criticalFailed = true;
      }
    }
    if (errors.length) throw new AggregateError(errors, 'lifecycle cleanup failed');
  }
}

/** Preserve the startup failure even if cleanup also fails. */
export async function startWithCleanup(
  start: () => Promise<void>,
  close: () => Promise<void>,
  reportCleanupError: (error: unknown) => void,
): Promise<void> {
  try { await start(); }
  catch (error) {
    try { await close(); } catch (cleanupError) {
      try { reportCleanupError(cleanupError); } catch { /* preserve startup error */ }
    }
    throw error;
  }
}
