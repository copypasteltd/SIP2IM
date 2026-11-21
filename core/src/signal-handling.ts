export type ShutdownSignal = 'SIGINT' | 'SIGTERM';

export interface SignalSource {
  on(signal: ShutdownSignal, listener: () => void): unknown;
  off(signal: ShutdownSignal, listener: () => void): unknown;
}

export interface SignalResult {
  signal?: ShutdownSignal;
  startupError?: unknown;
  cleanupError?: unknown;
  /** Disambiguates a thrown undefined from success. */
  startupFailed: boolean;
  cleanupFailed: boolean;
}

/**
 * Register before starting. Complete after the first signal or a startup failure,
 * waiting for startup to settle before running cleanup exactly once. The start
 * callback receives a synchronous admission fence and can request a stop when
 * a runtime prerequisite is lost. Startup failure also closes admission before
 * cleanup. The caller owns exit policy.
 * The startup operation must eventually settle, including after a signal.
 */
export function runWithSignals(
  source: SignalSource,
  start: (stopping: AbortSignal, requestStop: () => void) => void | Promise<void>,
  cleanup: () => void | Promise<void>,
): Promise<SignalResult> {
  let signal: ShutdownSignal | undefined;
  let wake!: () => void;
  const requested = new Promise<void>(resolve => { wake = resolve; });
  const stopping = new AbortController();
  const stop = (received?: ShutdownSignal): void => {
    if (stopping.signal.aborted) return;
    signal = received;
    stopping.abort();
    wake();
  };
  const onInt = () => stop('SIGINT');
  const onTerm = () => stop('SIGTERM');
  source.on('SIGINT', onInt);
  try { source.on('SIGTERM', onTerm); }
  catch (error) { source.off('SIGINT', onInt); throw error; }

  return (async () => {
    let startupFailed = false;
    let startupError: unknown;
    let cleanupFailed = false;
    let cleanupError: unknown;
    try {
      try { await start(stopping.signal, () => stop()); } catch (error) { startupFailed = true; startupError = error; }
      if (startupFailed) stop();
      else await requested;
      try { await cleanup(); } catch (error) { cleanupFailed = true; cleanupError = error; }
      return { signal, startupFailed, startupError, cleanupFailed, cleanupError };
    } finally {
      source.off('SIGINT', onInt);
      source.off('SIGTERM', onTerm);
    }
  })();
}
