/** Request shutdown once, and await it separately after session and media drains. */
export function websocketServerCloser(
  server: { close(callback: (error?: Error) => void): void; clients?: Set<{ terminate(): void }> },
  graceMs = 5000,
  terminationMs = 5000,
) {
  const asError = (value: unknown) => value instanceof Error ? value : new Error('WebSocket shutdown threw a non-Error value', { cause: value });
  let closing: Promise<void> | undefined;
  const start = () => {
    if (closing) return;
    closing = new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout>;
      let settled = false;
      let terminating = false;
      let callbackDuringTermination = false;
      let callbackError: unknown;
      const errors: unknown[] = [];
      const finish = (error?: unknown) => {
        if (settled) return;
        if (terminating) {
          callbackDuringTermination = true;
          callbackError = error;
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error !== undefined) errors.push(error);
        if (errors.length === 1) reject(errors[0]);
        else if (errors.length) reject(new AggregateError(errors, 'WebSocket server shutdown failed'));
        else resolve();
      };
      timer = setTimeout(() => {
        terminating = true;
        for (const client of server.clients ?? []) {
          try { client.terminate(); } catch (error) { errors.push(asError(error)); }
        }
        terminating = false;
        if (callbackDuringTermination) finish(callbackError);
        else timer = setTimeout(() => finish(new Error('WebSocket server close timed out')), terminationMs);
      }, graceMs);
      try { server.close(error => finish(error)); } catch (error) { finish(asError(error)); }
    });
    // The lifecycle awaits this after closing its clients.
    void closing.catch(() => {});
  };
  return { start, wait: () => { start(); return closing!; } };
}
