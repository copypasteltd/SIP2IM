import type { Settings } from './schema.js';

export interface DeviceConfig { heartbeatSec: number; locale: Settings['botLocale'] }
export interface ConfigAttachment {
  readonly deviceId: string;
  current(): boolean;
  send(config: DeviceConfig, current: () => boolean): Promise<{ ok: boolean; error: string | null }>;
}

type Receipt = { key: string; confirmed: boolean; retryAt: number };
const MAX_PER_PASS = 8;
const RETRY_MS = 30_000;

function configKey(config: DeviceConfig): string {
  if (!Number.isSafeInteger(config.heartbeatSec) || config.heartbeatSec < 1 || config.heartbeatSec > 86_400 ||
      !['en', 'zh-CN', 'zh-HK'].includes(config.locale)) throw new Error('Invalid device configuration readback');
  return config.heartbeatSec + ':' + config.locale;
}

/** Reconcile idempotent settings, never SMS or call commands. Only an exact ACK
 * on the same live attachment can confirm the applied payload. */
export class DeviceConfigSync {
  private readonly receipts = new WeakMap<ConfigAttachment, Receipt>();
  private lastServed: string | undefined;
  private active: Promise<void> | undefined;
  private epoch = 0;
  private rerun = false;
  private stopped = false;

  constructor(
    private readonly read: () => Promise<DeviceConfig>,
    private readonly attachments: () => readonly ConfigAttachment[],
    private readonly assertAdmission: () => void,
    private readonly reportReadFailure: () => void = () => {},
    private readonly clock: () => number = () => performance.now(),
  ) {}

  /** Invalidate an in-flight read at the setting transaction boundary. A wakeup
   * cannot carry request values; it merely schedules a new authoritative read. */
  invalidate(): void {
    if (this.stopped) return;
    ++this.epoch;
    this.rerun = true;
    void this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) return this.active;
    const work = Promise.resolve().then(async () => {
      try {
        // Coalesce a commit observed during this pass. Continuous settings churn
        // yields back to the timer rather than retaining one task indefinitely.
        for (let pass = 0; pass < 2 && !this.stopped; pass++) {
          this.rerun = false;
          const epoch = this.epoch;
          try { await this.reconcile(epoch); }
          catch {
            if (this.allowed(epoch)) {
              try { this.reportReadFailure(); } catch { /* Diagnostics do not control scheduling. */ }
            }
          }
          if (!this.rerun) break;
        }
      } finally { this.active = undefined; }
    });
    this.active = work;
    return work;
  }

  stop(): Promise<void> {
    this.stopped = true;
    this.rerun = false;
    return this.active ?? Promise.resolve();
  }

  private allowed(epoch: number): boolean {
    if (this.stopped || epoch !== this.epoch) return false;
    try { this.assertAdmission(); return true; } catch { return false; }
  }

  private async reconcile(epoch: number): Promise<void> {
    if (!this.allowed(epoch) || this.attachments().length === 0) return;
    const config = { ...await this.read() };
    if (!this.allowed(epoch)) return;
    const key = configKey(config);
    const now = this.clock();
    // Resume after the last served ID even when its socket disconnected or the
    // registry was reordered by a reconnect while the previous pass drained.
    const attached = [...this.attachments()].sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0);
    const cursor = this.lastServed;
    const next = cursor === undefined ? 0 : attached.findIndex(target => target.deviceId > cursor);
    const after = next < 0 ? 0 : next;
    const selected: ConfigAttachment[] = [];
    for (let i = 0; i < attached.length && selected.length < MAX_PER_PASS; i++) {
      const target = attached[(after + i) % attached.length]!;
      const receipt = this.receipts.get(target);
      if (target.current() && (receipt?.key !== key || (!receipt.confirmed && now >= receipt.retryAt))) selected.push(target);
    }
    if (selected.length) this.lastServed = selected.at(-1)!.deviceId;
    await Promise.allSettled(selected.map(target => this.apply(target, config, key, epoch)));
  }

  private async apply(target: ConfigAttachment, config: DeviceConfig, key: string, epoch: number): Promise<void> {
    const current = () => this.allowed(epoch) && target.current();
    if (!current()) return;
    // A newly submitted payload may have replaced any prior confirmation even
    // when its outcome is unknown. Never reuse a receipt for the older payload.
    this.receipts.delete(target);
    let confirmed = false;
    try {
      const ack = await target.send(config, current);
      confirmed = ack.ok === true && ack.error === null;
    } catch { /* Retry the latest settings at a later pass. */ }
    if (current()) this.receipts.set(target, { key, confirmed, retryAt: this.clock() + RETRY_MS });
  }
}
