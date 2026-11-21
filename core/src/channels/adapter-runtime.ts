import { AdapterIpcListener, type AdapterTransportSocket, type AdapterTransportHandlers } from '../adapters/ipc-listener.js';
import { AdapterManager, UnsupportedAdapterEvent } from './adapter-manager.js';

type Platform = 'qq' | 'telegram';
type State = { state: string; selfId: string | null; alias: string | null };
export interface AdapterRuntimeRepository {
  list(): Promise<unknown[]>;
  adapterOffline(platform: Platform): Promise<void>;
  adapterState(platform: Platform, state: State): Promise<void>;
  adapterCapabilities(platform: Platform, capabilities: unknown): Promise<void>;
}
type Listener = { start(): Promise<void>; close(): Promise<void> };
export interface AdapterRuntimeOptions {
  repository: AdapterRuntimeRepository;
  publish(type: string, data: unknown): Promise<void>;
  adapters: Record<Platform, { enabled: boolean; socket: string }>;
  listenerFactory?: (options: { path: string; onConnection(socket: AdapterTransportSocket): AdapterTransportHandlers }) => Listener;
}

/** Manages process-local generations; run exactly one runtime per database. */
export class AdapterRuntime {
  readonly manager: AdapterManager;
  private readonly generations = new Map<Platform, number>();
  private readonly queues = new Map<Platform, Promise<void>>();
  private readonly initialization = new Map<Platform, Promise<void>>();
  private readonly startupCapabilities = new Map<Platform, Record<string, unknown> | null>();
  private readonly shutdownQueueErrors = new Set<unknown>();
  private readonly listeners: Listener[] = [];
  private stopped = false;
  private closing = false;
  private starting: Promise<void> | undefined;
  private closePromise: Promise<void> | undefined;
  constructor(private readonly options: AdapterRuntimeOptions) {
    this.manager = new AdapterManager({
      onAttach: (platform, generation) => {
        if (this.closing || this.stopped) throw new Error('runtime closing');
        this.generations.set(platform, generation);
        this.startupCapabilities.set(platform, null);
        const initialization = this.enqueue(platform, async () => {
          if (!this.current(platform, generation)) return;
          await options.repository.adapterOffline(platform);
          await this.publishChannel(platform, generation);
        });
        this.initialization.set(platform, initialization);
        void initialization.catch(() => {});
      },
      onEvent: (platform, message, generation) => this.enqueue(platform, async () => {
        if (!this.current(platform, generation)) throw new Error('stale adapter');
        switch (message.type) {
          case 'adapter.hello': await this.initialization.get(platform); return;
          case 'capabilities': {
            const caps = { ...(message.payload as object), sendMessage:false, receiveMessage:false, dial:false, receiveAudio:false, sendAudio:false, maxConcurrentCalls:0 };
            if (this.startupCapabilities.has(platform)) { this.startupCapabilities.set(platform, caps); return; }
            await options.repository.adapterCapabilities(platform, caps);
            await this.publishChannel(platform, generation); return;
          }
          case 'account.state': {
            const caps = this.startupCapabilities.get(platform);
            await options.repository.adapterState(platform, message.payload as State);
            if (!this.current(platform, generation)) return;
            if (caps) {
              await options.repository.adapterCapabilities(platform, caps);
              if (!this.current(platform, generation)) return;
              this.startupCapabilities.delete(platform);
            }
            await this.publishChannel(platform, generation); return;
          }
          case 'login.step':
            // The manager accepts the live challenge before making it readable or broadcasting it.
            return;
          default: throw new UnsupportedAdapterEvent();
        }
      }),
      onLoginStep: (platform, step, generation) => this.enqueue(platform, async () => {
        if (!this.closing && this.current(platform, generation)) await options.publish('channel.login.step', { platform, ...step });
      }),
      onDisconnect: (platform, generation) => this.enqueue(platform, async () => {
        if (!this.current(platform, generation)) return;
        this.startupCapabilities.delete(platform);
        await options.repository.adapterOffline(platform);
        await this.publishChannel(platform, generation);
      }),
    });
    const factory = options.listenerFactory ?? (opts => new AdapterIpcListener(opts));
    for (const platform of ['qq', 'telegram'] as const) {
      const config = options.adapters[platform];
      if (config.enabled) this.listeners.push(factory({ path: config.socket, onConnection: socket => { if (this.closing || this.stopped) { socket.destroy(); throw new Error('runtime closing'); } return this.manager.attach(platform, socket); } }));
    }
  }
  private current(platform: Platform, generation: number): boolean { return !this.stopped && this.generations.get(platform) === generation; }
  private enqueue(platform: Platform, work: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(platform) ?? Promise.resolve()).catch(() => {}).then(work);
    void next.catch(error => { if (this.closing) this.shutdownQueueErrors.add(error); });
    this.queues.set(platform, next);
    return next;
  }
  private async publishChannel(platform: Platform, generation: number): Promise<void> {
    if (!this.current(platform, generation)) return;
    const channel = (await this.options.repository.list()).find(row => (row as { platform?: string }).platform === platform);
    if (channel && this.current(platform, generation)) await this.options.publish('channel.updated', channel);
  }
  start(): Promise<void> {
    if (this.closing || this.stopped || this.starting) return Promise.reject(new Error('runtime unavailable'));
    this.starting = this.startListeners();
    return this.starting;
  }
  private async startListeners(): Promise<void> {
    // Reconcile stale persisted status even when an adapter is disabled.
    const reconciliation = await Promise.allSettled((['qq', 'telegram'] as const).map(platform => this.options.repository.adapterOffline(platform)));
    const reconciliationErrors = reconciliation.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
    if (reconciliationErrors.length) throw new AggregateError(reconciliationErrors, 'adapter startup reconciliation failed');
    const started: Listener[] = [];
    try { for (const listener of this.listeners) { started.push(listener); await listener.start(); } }
    catch (error) {
      const errors: unknown[] = [error];
      for (const listener of started.reverse()) { try { await listener.close(); } catch (cleanupError) { errors.push(cleanupError); } }
      if (errors.length > 1) throw new AggregateError(errors, 'adapter startup failed; listener cleanup outcome unknown');
      throw error;
    }
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.manager.stopAdmission();
    this.closePromise = this.closeListeners();
    return this.closePromise;
  }
  private async closeListeners(): Promise<void> {
    const errors: unknown[] = [];
    if (this.starting) { try { await this.starting; } catch (error) { errors.push(error); } }
    for (const listener of this.listeners) { try { await listener.close(); } catch (error) { errors.push(error); } }
    try { this.manager.close(); } catch (error) { errors.push(error); }
    await this.manager.drainEvidence();
    const results = await Promise.allSettled([...this.queues.values()]);
    for (const result of results) if (result.status === 'rejected') this.shutdownQueueErrors.add(result.reason);
    errors.push(...this.shutdownQueueErrors);
    this.stopped = true;
    if (errors.length) throw new AggregateError(errors, 'adapter runtime shutdown failed; cleanup outcome unknown');
  }
}
