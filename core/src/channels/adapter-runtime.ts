import { AdapterIpcListener, type AdapterTransportSocket, type AdapterTransportHandlers } from '../adapters/ipc-listener.js';
import { AdapterManager, UnsupportedAdapterEvent } from './adapter-manager.js';
import type { AlertEvent } from '../alerts/episodes.js';
import type { ChannelAccountOptions, ChannelObservationOptions, ChannelWriteFence } from './repo.js';

type Platform = 'qq' | 'telegram';
type State = { state: string; selfId: string | null; alias: string | null };
type Current = () => boolean;
export interface AdapterRuntimeRepository {
  list(): Promise<unknown[]>;
  adapterOffline(platform: Platform, options?: ChannelObservationOptions): Promise<AlertEvent | null | void>;
  adapterState(platform: Platform, state: State, options?: ChannelAccountOptions): Promise<AlertEvent | null | void>;
  adapterCapabilities(platform: Platform, capabilities: unknown, options?: ChannelWriteFence): Promise<void>;
}
type Listener = { start(): Promise<void>; close(): Promise<void> };
export interface AdapterRuntimeOptions {
  repository: AdapterRuntimeRepository;
  // Check isCurrent again at the final send, after any asynchronous subscriber authorization.
  publish(type: string, data: unknown, isCurrent: Current): Promise<void>;
  adapters: Record<Platform, { enabled: boolean; socket: string }>;
  stopping?: AbortSignal;
  ownsDatabase?: Current;
  listenerFactory?: (options: { path: string; onConnection(socket: AdapterTransportSocket): AdapterTransportHandlers }) => Listener;
}

type NoticeKind = 'channel' | 'alert' | 'step';
type Notice = { isCurrent: Current; send(current: Current): Promise<void> };
type NoticeLane = { latest: Map<NoticeKind, Notice>; running?: Promise<void> };
const staleReport = new Error('Adapter report is no longer current');

/** Manages process-local generations; run exactly one runtime per database. */
export class AdapterRuntime {
  readonly manager: AdapterManager;
  private readonly generations = new Map<Platform, number>();
  private readonly attached = new Set<Platform>();
  private readonly queues = new Map<Platform, Promise<void>>();
  private readonly initialization = new Map<Platform, Promise<void>>();
  private readonly startupLogin = new Map<Platform, boolean | null>();
  private readonly notifications = new Map<Platform, NoticeLane>();
  private readonly shutdownQueueErrors = new Set<unknown>();
  private readonly listeners: Listener[] = [];
  private stopped = false;
  private closing = false;
  private starting: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  private readonly freeze = () => {
    this.manager.stopAdmission();
    for (const lane of this.notifications.values()) lane.latest.clear();
  };

  constructor(private readonly options: AdapterRuntimeOptions) {
    this.manager = new AdapterManager({
      onAttach: (platform, generation) => {
        if (this.isStopping() || !this.hasOwnership()) throw new Error('runtime unavailable');
        this.generations.set(platform, generation);
        this.attached.add(platform);
        this.notifications.get(platform)?.latest.clear();
        this.startupLogin.set(platform, null);
        const isCurrent = () => this.reportCurrent(platform, generation);
        const initialization = this.enqueue(platform, async () => {
          if (!isCurrent()) return;
          // Reset alone is not an observed outage. A report or disconnect can settle it later.
          await options.repository.adapterOffline(platform, { observeOutage: false, isCurrent });
          if (isCurrent()) this.notifyChannel(platform, generation);
        });
        this.initialization.set(platform, initialization);
      },
      onEvent: (platform, message, generation) => this.enqueue(platform, async () => {
        const isCurrent = () => this.reportCurrent(platform, generation);
        const requireCurrent = () => { if (!isCurrent()) throw staleReport; };
        requireCurrent();
        switch (message.type) {
          case 'adapter.hello':
            await this.initialization.get(platform);
            requireCurrent();
            this.initialization.delete(platform);
            return;
          case 'capabilities': {
            const login = (message.payload as { login: boolean }).login === true;
            if (this.startupLogin.has(platform)) { this.startupLogin.set(platform, login); return; }
            await options.repository.adapterCapabilities(platform, { login }, { isCurrent });
            requireCurrent();
            this.notifyChannel(platform, generation);
            return;
          }
          case 'account.state': {
            const initialLoginSupport = this.startupLogin.get(platform);
            if (initialLoginSupport === null) throw new Error('Missing startup capabilities');
            const event = await options.repository.adapterState(platform, message.payload as State, {
              isCurrent, ...(initialLoginSupport === undefined ? {} : { initialLoginSupport }),
            });
            requireCurrent();
            this.startupLogin.delete(platform);
            this.notifyAlert(event, platform, generation);
            this.notifyChannel(platform, generation);
            return;
          }
          case 'login.step':
            // The manager accepts the live challenge before it is readable or published.
            return;
          default: throw new UnsupportedAdapterEvent();
        }
      }),
      onLoginStep: (platform, step, generation, stepIsCurrent) => {
        this.notify(platform, generation, 'step', current => options.publish('channel.login.step', { platform, ...step }, current), stepIsCurrent);
      },
      onDisconnect: (platform, generation) => {
        if (!this.current(platform, generation)) return Promise.resolve();
        // Fence report writes immediately, while retaining this generation's right
        // to reconcile its own disconnect unless a newer attachment supersedes it.
        this.attached.delete(platform);
        this.initialization.delete(platform);
        this.startupLogin.delete(platform);
        this.notifications.get(platform)?.latest.clear();
        return this.enqueue(platform, async () => {
          const isCurrent = () => this.current(platform, generation);
          if (!isCurrent()) return;
          const event = await options.repository.adapterOffline(platform, { observeOutage: !this.isStopping(), isCurrent });
          this.notifyAlert(event, platform, generation);
          this.notifyChannel(platform, generation);
        });
      },
    });
    const factory = options.listenerFactory ?? (opts => new AdapterIpcListener(opts));
    for (const platform of ['qq', 'telegram'] as const) {
      const config = options.adapters[platform];
      if (config.enabled) this.listeners.push(factory({ path: config.socket, onConnection: socket => this.manager.attach(platform, socket) }));
    }
    options.stopping?.addEventListener('abort', this.freeze, { once: true });
    if (options.stopping?.aborted) this.freeze();
  }

  private isStopping(): boolean { return this.closing || this.stopped || this.options.stopping?.aborted === true; }
  private hasOwnership(): boolean { return this.options.ownsDatabase?.() ?? true; }
  private current(platform: Platform, generation: number): boolean {
    return !this.stopped && this.hasOwnership() && this.generations.get(platform) === generation;
  }
  private reportCurrent(platform: Platform, generation: number): boolean {
    return !this.isStopping() && this.attached.has(platform) && this.current(platform, generation);
  }
  private enqueue(platform: Platform, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(platform) ?? Promise.resolve()).catch(() => {}).then(work);
    void next.catch(error => { if (this.closing && error !== staleReport) this.shutdownQueueErrors.add(error); });
    this.queues.set(platform, next);
    return next;
  }

  // At most one publication in flight per platform, and one latest slot per kind.
  // Replaced notifications are only hints; durable status and alerts are read back separately.
  private notify(platform: Platform, generation: number, kind: NoticeKind, send: Notice['send'], evidence: Current = () => true): void {
    if (this.isStopping() || !this.current(platform, generation)) return;
    const lane: NoticeLane = this.notifications.get(platform) ?? { latest: new Map() };
    this.notifications.set(platform, lane);
    const notice: Notice = {
      isCurrent: () => !this.isStopping() && this.current(platform, generation) && lane.latest.get(kind) === notice && evidence(),
      send,
    };
    lane.latest.delete(kind);
    lane.latest.set(kind, notice);
    if (!lane.running) lane.running = Promise.resolve().then(() => this.publishPending(lane));
  }
  private async publishPending(lane: NoticeLane): Promise<void> {
    try {
      while (!this.isStopping()) {
        const next = lane.latest.entries().next().value;
        if (!next) break;
        const [kind, notice] = next;
        try { if (notice.isCurrent()) await notice.send(notice.isCurrent); }
        catch { /* Readback or publication failure does not change a committed report's ACK. */ }
        if (lane.latest.get(kind) === notice) lane.latest.delete(kind);
      }
    } finally { lane.running = undefined; }
  }
  private notifyAlert(event: AlertEvent | null | void, platform: Platform, generation: number): void {
    if (event) this.notify(platform, generation, 'alert', current => this.options.publish(event.type, event.data, current));
  }
  private notifyChannel(platform: Platform, generation: number): void {
    this.notify(platform, generation, 'channel', async current => {
      const channel = (await this.options.repository.list()).find(row => (row as { platform?: string }).platform === platform);
      if (channel && current()) await this.options.publish('channel.updated', channel, current);
    });
  }

  start(): Promise<void> {
    if (this.isStopping() || !this.hasOwnership() || this.starting) return Promise.reject(new Error('runtime unavailable'));
    this.starting = Promise.resolve().then(() => this.startListeners());
    return this.starting;
  }
  private async startListeners(): Promise<void> {
    if (this.isStopping() || !this.hasOwnership()) return;
    // Reconcile stale persisted status even when an adapter is disabled.
    const reconciliation = await Promise.allSettled((['qq', 'telegram'] as const).map(platform => Promise.resolve().then(() =>
      this.options.repository.adapterOffline(platform, {
        observeOutage: this.options.adapters[platform].enabled ? 'persisted-login' : false,
        isCurrent: () => !this.isStopping() && this.hasOwnership(),
      }))));
    const reconciliationErrors = reconciliation.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (reconciliationErrors.length) throw new AggregateError(reconciliationErrors, 'adapter startup reconciliation failed');
    const started: Listener[] = [];
    try {
      for (const listener of this.listeners) {
        if (this.isStopping() || !this.hasOwnership()) break;
        started.push(listener);
        await listener.start();
      }
    } catch (error) {
      const errors: unknown[] = [error];
      for (const listener of started.reverse()) { try { await listener.close(); } catch (cleanupError) { errors.push(cleanupError); } }
      if (errors.length > 1) throw new AggregateError(errors, 'adapter startup failed; listener cleanup outcome unknown');
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.options.stopping?.removeEventListener('abort', this.freeze);
    this.freeze();
    this.closePromise = Promise.resolve().then(() => this.closeListeners());
    return this.closePromise;
  }
  private async closeListeners(): Promise<void> {
    const errors: unknown[] = [];
    if (this.starting) { try { await this.starting; } catch (error) { errors.push(error); } }
    for (const listener of this.listeners) { try { await listener.close(); } catch (error) { errors.push(error); } }
    try { this.manager.close(); } catch (error) { errors.push(error); }
    await this.manager.drainEvidence();
    const results = await Promise.allSettled([...this.queues.values()]);
    for (const result of results) if (result.status === 'rejected' && result.reason !== staleReport) this.shutdownQueueErrors.add(result.reason);
    await Promise.all([...this.notifications.values()].map(lane => lane.running));
    errors.push(...this.shutdownQueueErrors);
    this.stopped = true;
    if (errors.length) throw new AggregateError(errors, 'adapter runtime shutdown failed; cleanup outcome unknown');
  }
}
