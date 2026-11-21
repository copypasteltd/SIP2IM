import { TransactionCommitUnknown, TransactionReleaseFailed } from '../db/pool.js';

/** Find transaction outcomes in nested cleanup failures without trusting error messages. */
export function transactionOutcome(error: unknown): 'unknown' | 'committed' | null {
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  let committed = false;
  try {
    while (pending.length) {
      if (seen.size >= 1024) return 'unknown';
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (current instanceof TransactionCommitUnknown) return 'unknown';
      if (current instanceof TransactionReleaseFailed) committed = true;
      if (current instanceof AggregateError) {
        const errors: unknown = current.errors;
        if (!Array.isArray(errors)) return 'unknown';
        const length = errors.length;
        if (!Number.isSafeInteger(length) || length < 0 || length > 1024 - seen.size - pending.length) return 'unknown';
        for (let i = 0; i < length; i++) pending.push(errors[i]);
      }
    }
    return committed ? 'committed' : null;
  } catch {
    // Incomplete inspection cannot establish a committed or rolled-back outcome.
    return 'unknown';
  }
}
