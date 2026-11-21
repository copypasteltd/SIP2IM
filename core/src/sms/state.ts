export type SmsState = 'queued'|'dispatched'|'accepted'|'sent'|'delivered'|'failed'|'unknown';
export type SmsEvent = 'dispatch'|'ack_ok'|'ack_error'|'ack_timeout'|'sent'|'delivered'|'failed'|'unknown'|'queue_expired';
export function transitionSms(state: SmsState, event: SmsEvent): SmsState { const transitions: Partial<Record<SmsState, Partial<Record<SmsEvent,SmsState>>>> = { queued:{dispatch:'dispatched',queue_expired:'failed'}, dispatched:{ack_ok:'accepted',ack_error:'failed',ack_timeout:'unknown'}, accepted:{sent:'sent',failed:'failed',unknown:'unknown'}, unknown:{sent:'sent',failed:'failed'}, sent:{delivered:'delivered'} }; return transitions[state]?.[event] ?? state; }
export class SimRateLimiter {
  private buckets = new Map<string, {tokens:number; at:number; rate:number}>();
  constructor(private readonly now: () => number = Date.now) {}

  // A finite rate changes when this SIM is observed. Settle the preceding interval
  // at its old rate and capacity before applying the new capacity. Increasing the
  // capacity does not grant tokens. Keep a high-water timestamp across clock rollback.
  private settle(simId: string, rate: number, now: number) {
    const b = this.buckets.get(simId);
    if (!b) return undefined;
    b.tokens = Math.min(b.rate, b.tokens + Math.max(0, now - b.at) * b.rate / 60000);
    b.tokens = Math.min(rate, b.tokens);
    b.at = Math.max(b.at, now);
    b.rate = rate;
    return b;
  }

  // Call synchronously for confirmed global settings changes. Unknown settings
  // must not be passed here. Unlimited preserves finite buckets and their rates.
  setGlobalRate(perMinute: number | null): void {
    if (perMinute === null) return;
    if (!Number.isFinite(perMinute) || perMinute <= 0) throw new Error('Invalid rate');
    const now = this.now();
    if (!Number.isFinite(now)) throw new Error('Invalid clock');
    for (const simId of this.buckets.keys()) this.settle(simId, perMinute, now);
  }

  refund(simId: string, perMinute: number | null): void {
    if (perMinute === null) return;
    const b = this.buckets.get(simId);
    // The reservation rate may be stale after another observation changes capacity.
    if (b) b.tokens = Math.min(b.rate, b.tokens + 1);
  }

  waitMs(simId: string, perMinute: number): number {
    if (!Number.isFinite(perMinute) || perMinute < 1) throw new Error('Invalid rate');
    const now = this.now();
    const b = this.settle(simId, perMinute, now);
    if (!b || b.tokens >= 1) return 0;
    return Math.max(0, b.at - now) + Math.ceil((1 - b.tokens) * 60000 / perMinute);
  }

  take(simId: string, perMinute: number | null): boolean {
    // Unlimited operations bypass and preserve any finite bucket; its last finite
    // rate remains in effect until the next finite observation of this SIM.
    if (perMinute === null) return true;
    if (!Number.isFinite(perMinute) || perMinute <= 0) throw new Error('Invalid rate');
    const now = this.now();
    const b = this.settle(simId, perMinute, now) ?? {tokens:perMinute, at:now, rate:perMinute};
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(simId, b);
    return allowed;
  }
}
