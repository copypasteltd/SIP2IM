import { AsyncLocalStorage } from 'node:async_hooks';

/** A lease represents all effects of one admitted operation, including its spawned work. */
export interface AdmissionLease {
  /** Call only when every effect covered by this lease has settled. Idempotent. */
  release(): void;
}

export interface QuiescenceResult {
  /** True only when every registered stop hook succeeded and every lease was released. */
  readonly safe: boolean;
  readonly errors: readonly unknown[];
}

/**
 * Coordinates admission and quiescence within one JavaScript agent.
 *
 * The owner must register every producer's stop hook before starting it, and
 * acquire a lease synchronously before an operation can start or spawn effects.
 * A hook succeeds only after its producer has stopped and its own effects have
 * settled. The coordinator cannot establish coverage of unregistered work.
 */
export class QuiescenceCoordinator {
  private open = true;
  private active = 0;
  private readonly stopHooks: Array<() => unknown | PromiseLike<unknown>> = [];
  private readonly hookContext = new AsyncLocalStorage<boolean>();
  private drainPromise?: Promise<QuiescenceResult>;
  private drained?: () => void;

  /** Returns undefined once shutdown has synchronously closed admission. */
  admit(): AdmissionLease | undefined {
    if (!this.open) return undefined;
    this.active++;
    let released = false;
    return { release: () => {
      if (released) return;
      released = true;
      this.active--;
      if (this.active === 0) this.drained?.();
    } };
  }

  /** Invoke work synchronously after admission and release on settlement.
   * The returned promise preserves the work's result or error. Spawned effects
   * must be included in that promise; otherwise acquire a longer-lived lease.
   */
  run<T>(work: () => T | PromiseLike<T>): Promise<Awaited<T>> | undefined {
    const lease = this.admit();
    if (!lease) return undefined;
    try {
      return Promise.resolve(work()).finally(() => lease.release());
    } catch (error) {
      lease.release();
      return Promise.reject(error);
    }
  }

  /** Register before starting a producer; registration is forbidden after shutdown.
   * A stop hook and its async descendants must not call shutdown on this coordinator.
   */
  registerStop(stop: () => unknown | PromiseLike<unknown>): void {
    if (!this.open) throw new Error('quiescence admission closed');
    this.stopHooks.push(stop);
  }

  /**
   * Close admission before returning. All callers share one drain; no timeout
   * can turn unfinished or failed cleanup into a positive safety result.
   */
  shutdown(): Promise<QuiescenceResult> {
    if (this.hookContext.getStore()) throw new Error('stop hook cannot await its own shutdown');
    if (this.drainPromise) return this.drainPromise;
    this.open = false;
    // Assign the shared promise before invoking hooks, including re-entrant ones.
    this.drainPromise = Promise.resolve().then(() => this.drain());
    return this.drainPromise;
  }

  private async drain(): Promise<QuiescenceResult> {
    const hooks = this.stopHooks.map(stop => Promise.resolve().then(() => this.hookContext.run(true, stop)));
    const leases = this.active === 0 ? Promise.resolve() : new Promise<void>(resolve => { this.drained = resolve; });
    const results = await Promise.allSettled(hooks);
    await leases;
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : []);
    return { safe: errors.length === 0, errors };
  }
}
