import { createHash, randomUUID } from 'node:crypto';
import { IpcDecoder, decodeAdapterJson, encodeAdapterJson, encodeIpcFrame } from '@voipgw/protocol';
import { ulid } from 'ulid';

export type AdapterPlatform = 'qq' | 'telegram';
export type AdapterLoginCommand = 'account.login' | 'account.login.submit' | 'account.logout';
type AdapterLoginPrompt = { step: 'qr' | 'phone' | 'code' | 'password'; qrPngBase64: string | null; hint: string | null };
export type AdapterLoginStep = AdapterLoginPrompt & { challengeId: string };
export type AdapterAck = { refId: string; ok: boolean; error: string | null };
export type AdapterAdmissionCode = 'CHANNEL_UNAVAILABLE' | 'CAPABILITY_UNSUPPORTED' | 'BAD_MESSAGE' | 'INTERNAL';
type LateEvidence = (ack: AdapterAck) => Promise<void>;
const LATE_ACK_WINDOW_MS = 30_000;
type AckWindow = {deadline: number; timer: ReturnType<typeof setTimeout> | undefined};
type PendingAck = AckWindow & {resolve: (ack: AdapterAck) => void; reject: (error: Error) => void; observeLate?: LateEvidence};
type LateAck = AckWindow & {observe: LateEvidence};
export type AdapterLoginDispatch = (observeLate?: LateEvidence) => Promise<AdapterAck>;
export interface AdapterLoginTransport {
  /** Prepare without writing. The one-shot dispatch rechecks the same live adapter session. */
  prepareLogin(platform: AdapterPlatform, type: AdapterLoginCommand, payload: unknown): AdapterLoginDispatch;
}
type Message = ReturnType<typeof decodeAdapterJson>;
type AccountState = { state: string; selfId: string | null };
type ReportedCapabilities = { login: boolean };
export interface AdapterSocket { write(data: Uint8Array): void; destroy(): void }
export interface AdapterManagerDeps {
  // Callbacks are ordered per connection. They must not log login credentials.
  onEvent(platform: AdapterPlatform, message: Message, generation: number): Promise<void>;
  onDisconnect(platform: AdapterPlatform, generation: number): Promise<void>;
  onAttach?(platform: AdapterPlatform, generation: number): void;
  onLoginStep?(platform: AdapterPlatform, step: AdapterLoginStep, generation: number, isCurrent: () => boolean): void | Promise<void>;
}

export class UnsupportedAdapterEvent extends Error {}
/** Only raised before a command can reach the socket; adapter NACKs are not this evidence. */
export class AdapterAdmissionRejected extends Error {
  constructor(readonly code: AdapterAdmissionCode) { super(code); }
}

/** Control-plane transport. A connection generation is not a verified bridge-account identity. */
export class AdapterManager implements AdapterLoginTransport {
  private sessions = new Map<AdapterPlatform, Session>();
  private generations = new Map<AdapterPlatform, number>();
  private accepting = true;
  private readonly evidenceWrites = new Set<Promise<void>>();
  constructor(private readonly deps: AdapterManagerDeps, private readonly timeoutMs = 10_000,
    private readonly now: () => number = () => performance.now()) {}
  attach(platform: AdapterPlatform, socket: AdapterSocket): { data(bytes: Uint8Array): void; close(): void } {
    if (!this.accepting) { socket.destroy(); throw new Error('manager closed'); }
    const generation = (this.generations.get(platform) ?? 0) + 1;
    this.generations.set(platform, generation);
    const previous = this.sessions.get(platform);
    this.sessions.delete(platform);
    previous?.stop();
    try { this.deps.onAttach?.(platform, generation); } catch (error) { socket.destroy(); throw error; }
    const session: Session = new Session(platform, generation, socket, this.deps, this.timeoutMs, this.now,
      (): boolean => this.accepting && this.sessions.get(platform) === session, () => {
      if (this.sessions.get(platform) !== session) return;
      this.sessions.delete(platform);
      void this.deps.onDisconnect(platform, generation).catch(() => {});
    });
    this.sessions.set(platform, session);
    return { data: bytes => session.data(bytes), close: () => session.stop() };
  }
  prepareLogin(platform: AdapterPlatform, type: AdapterLoginCommand, payload: unknown): AdapterLoginDispatch {
    const session = this.sessions.get(platform);
    if (!this.accepting) throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE');
    const missingSession = type === 'account.login.submit' ? 'BAD_MESSAGE' : 'CHANNEL_UNAVAILABLE';
    if (!session) throw new AdapterAdmissionRejected(missingSession);
    const dispatch = session.prepareLogin(type, payload);
    return observeLate => {
      if (!this.accepting) throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE');
      if (this.sessions.get(platform) !== session) throw new AdapterAdmissionRejected(missingSession);
      return dispatch(observeLate && (ack => {
        const work = Promise.resolve().then(() => observeLate(ack)).catch(() => {});
        this.evidenceWrites.add(work);
        void work.then(() => this.evidenceWrites.delete(work));
        return work;
      }));
    };
  }
  async send(platform: AdapterPlatform, type: AdapterLoginCommand | 'message.send', payload: unknown): Promise<AdapterAck> {
    if (type === 'message.send') throw new AdapterAdmissionRejected('CAPABILITY_UNSUPPORTED');
    return this.prepareLogin(platform, type, payload)();
  }
  loginStep(platform: AdapterPlatform): AdapterLoginStep | null {
    return this.accepting ? this.sessions.get(platform)?.loginStep() ?? null : null;
  }
  /** All startup reports were accepted. Does not indicate platform login or voice capability. */
  status(platform: AdapterPlatform): 'online' | 'offline' | 'unknown' {
    const session = this.sessions.get(platform);
    return !this.accepting || !session ? 'offline' : session.isReady() ? 'online' : 'unknown';
  }
  stopAdmission(): void { this.accepting = false; }
  /** Call after closing sessions: late evidence already admitted must settle before closing the pool. */
  async drainEvidence(): Promise<void> { await Promise.all([...this.evidenceWrites]); }
  close(): void {
    this.stopAdmission();
    const errors: unknown[] = [];
    for (const session of [...this.sessions.values()]) { try { session.stop(); } catch (error) { errors.push(error); } }
    if (errors.length) throw new AggregateError(errors, 'adapter session cleanup failed; outcome unknown');
  }
}

const startup = ['adapter.hello', 'capabilities', 'account.state'] as const;
const inbound = new Set<string>([...startup, 'login.step', 'message.received', 'call.state', 'call.incoming.rejected']);

class Session {
  private decoder = new IpcDecoder();
  private active = true;
  private phase = 0;
  private loginSupported = false;
  private account: AccountState | undefined;
  private step: AdapterLoginStep | null = null;
  private controlRevision = 0;
  private controlReports = 0;
  private queue = Promise.resolve();
  private queued = 0;
  private readonly pending = new Map<string, PendingAck>();
  private readonly lateAcks = new Map<string, LateAck>();
  private seen = new Map<string, { digest: string; ack: AdapterAck }>();
  constructor(private platform: AdapterPlatform, private generation: number, private socket: AdapterSocket, private deps: AdapterManagerDeps, private timeoutMs: number,
    private readonly now: () => number, private readonly admitsLogin: () => boolean, private closed: () => void) {}
  isReady(): boolean { return this.active && this.phase === startup.length; }
  loginStep(): AdapterLoginStep | null { return this.isReady() && this.controlReports === 0 && this.step ? { ...this.step } : null; }
  data(bytes: Uint8Array): void {
    if (!this.active) return;
    try {
      for (const frame of this.decoder.push(bytes)) {
        if (frame.type !== 1) throw new Error('audio unsupported');
        const message = decodeAdapterJson(frame.data);
        // ACKs bypass callbacks and remain scoped to this socket's pending command IDs.
        if (message.type === 'ack') { this.ack(message.payload as AdapterAck); continue; }
        if (++this.queued > 500) { this.stop(); return; }
        let reportPending = ['capabilities','account.state','login.step'].includes(message.type);
        if (reportPending) this.controlReports++;
        const reportSettled = () => { if (reportPending) { reportPending = false; this.controlReports--; } };
        this.queue = this.queue.then(() => this.receive(message, reportSettled)).catch(() => this.stop()).finally(() => { reportSettled(); this.queued--; });
      }
    } catch { this.stop(); }
  }
  private async receive(message: Message, reportSettled: () => void): Promise<void> {
    if (!this.active) return;
    const digest = createHash('sha256').update(JSON.stringify(message)).digest('hex');
    const previous = this.seen.get(message.id);
    if (previous) {
      if (previous.digest !== digest) { this.stop(); return; }
      this.writeAck(previous.ack);
      return;
    }
    const initializing = this.phase < startup.length;
    if (!inbound.has(message.type) || (initializing ? message.type !== startup[this.phase] : message.type === 'adapter.hello')) { this.stop(); return; }
    if (message.type === 'adapter.hello' && (message.payload as {platform: AdapterPlatform}).platform !== this.platform) { this.stop(); return; }
    const controlReport = message.type === 'capabilities' || message.type === 'account.state';
    let ack: AdapterAck;
    let prompt: AdapterLoginStep | null = null;
    try {
      if (message.type === 'login.step' && (!this.loginSupported || this.account?.state !== 'login_pending')) throw new UnsupportedAdapterEvent();
      await this.deps.onEvent(this.platform, message, this.generation);
      if (!this.active) return;
      if (message.type === 'capabilities') {
        this.loginSupported = (message.payload as ReportedCapabilities).login;
        if (!this.loginSupported) this.step = null;
      } else if (message.type === 'account.state') {
        const next = message.payload as AccountState;
        if (next.state !== 'login_pending' || next.selfId !== this.account?.selfId || this.account?.state !== next.state) this.step = null;
        this.account = { state: next.state, selfId: next.selfId };
      } else if (message.type === 'login.step') {
        // Exact duplicate frames return above; only a newly accepted report gets an ID.
        this.step = prompt = { ...(message.payload as AdapterLoginPrompt), challengeId: randomUUID() };
      }
      if (controlReport || prompt) this.controlRevision++;
      ack = { refId: message.id, ok: true, error: null };
    } catch (error) {
      ack = { refId: message.id, ok: false, error: error instanceof UnsupportedAdapterEvent ? 'CAPABILITY_UNSUPPORTED' : 'INTERNAL' };
    } finally {
      reportSettled();
    }
    if (!this.active) return;
    this.seen.set(message.id, {digest, ack});
    if (this.seen.size > 500) this.seen.delete(this.seen.keys().next().value!);
    this.writeAck(ack);
    if (!this.active) return;
    if (initializing && ack.ok) this.phase++;
    if ((initializing || controlReport) && !ack.ok) { this.stop(); return; }
    if (prompt) {
      const accepted = prompt;
      const isCurrent = () => this.isReady() && this.controlReports === 0 && this.step === accepted;
      try {
        const enqueue = this.deps.onLoginStep?.(this.platform, { ...accepted }, this.generation, isCurrent);
        void Promise.resolve(enqueue).catch(() => {});
      } catch { /* Notification is optional and cannot undo the ACK. */ }
    }
  }
  private assertLoginReady(): void {
    if (!this.admitsLogin() || !this.isReady() || this.controlReports !== 0) throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE');
    if (!this.loginSupported) throw new AdapterAdmissionRejected('CAPABILITY_UNSUPPORTED');
  }
  prepareLogin(type: AdapterLoginCommand, payload: unknown): AdapterLoginDispatch {
    let wirePayload = payload;
    let challengeId: string | undefined;
    if (type === 'account.login.submit') {
      const input = payload as Partial<{step: unknown; value: unknown; challengeId: unknown}> | null | undefined;
      const challenge = this.step;
      if (!challenge || input?.step !== challenge.step || input.challengeId !== challenge.challengeId ||
          typeof input.value !== 'string' || input.value.length === 0) throw new AdapterAdmissionRejected('BAD_MESSAGE');
      challengeId = challenge.challengeId;
      wirePayload = { step: challenge.step, value: input.value };
    }
    this.assertLoginReady();
    const revision = this.controlRevision;
    const id = 'ipc_' + ulid();
    let bytes: Uint8Array;
    try { bytes = encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type,id,ts:Date.now(),payload:wirePayload})}); }
    catch { throw new AdapterAdmissionRejected('INTERNAL'); }
    const assertCurrent = () => {
      if (challengeId !== undefined && this.step?.challengeId !== challengeId) throw new AdapterAdmissionRejected('BAD_MESSAGE');
      this.assertLoginReady();
      if (this.controlRevision !== revision) throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE');
    };
    let used = false;
    return observeLate => {
      if (used) throw new AdapterAdmissionRejected('CHANNEL_UNAVAILABLE');
      assertCurrent();
      used = true;
      let write: AdapterSocket['write'];
      try { write = this.socket.write; }
      catch { throw new AdapterAdmissionRejected('INTERNAL'); }
      assertCurrent();
      if (this.pending.has(id) || this.lateAcks.has(id)) throw new AdapterAdmissionRejected('INTERNAL');
      // Only a newly accepted login.step can make the consumed prompt actionable again.
      this.step = null;
      this.controlRevision++;
      return new Promise((resolve, reject) => {
        const entry: PendingAck = {resolve, reject, observeLate, deadline:this.now() + this.timeoutMs, timer:undefined};
        this.pending.set(id, entry);
        try { Reflect.apply(write, this.socket, [bytes]); }
        catch {
          if (this.take(this.pending, id, entry)) reject(new Error('send failed; outcome unknown'));
          return;
        }
        // A synchronous ACK or close may already have consumed the entry.
        this.watch(this.pending, id, entry, at => {
          entry.reject(new Error('timeout; outcome unknown'));
          const deadline = entry.deadline + LATE_ACK_WINDOW_MS;
          if (this.active && entry.observeLate && at < deadline) this.rememberLateAck(id, entry.observeLate, deadline, at);
        });
      });
    };
  }
  private take<T extends AckWindow>(entries: Map<string, T>, id: string, entry: T): boolean {
    if (entries.get(id) !== entry) return false;
    entries.delete(id);
    if (entry.timer !== undefined) clearTimeout(entry.timer);
    entry.timer = undefined;
    return true;
  }
  private watch<T extends AckWindow>(entries: Map<string,T>, id: string, entry: T, expired: (at:number)=>void, unref = false): void {
    const check = () => {
      if (entries.get(id) !== entry) return;
      const at = this.now(), remaining = entry.deadline - at;
      if (remaining <= 0) {
        if (this.take(entries, id, entry)) expired(at);
      } else {
        entry.timer = setTimeout(check, Math.ceil(remaining));
        if (unref) entry.timer.unref();
      }
    };
    check();
  }
  private rememberLateAck(id: string, observe: LateEvidence, deadline: number, at: number): void {
    if (this.lateAcks.size >= 128) {
      for (const [key, entry] of this.lateAcks) {
        if (entry.deadline <= at) this.take(this.lateAcks, key, entry);
      }
    }
    if (this.lateAcks.size >= 128) {
      const oldest = this.lateAcks.keys().next().value!;
      this.take(this.lateAcks, oldest, this.lateAcks.get(oldest)!);
    }
    const entry: LateAck = {observe, deadline, timer:undefined};
    this.lateAcks.set(id, entry);
    this.watch(this.lateAcks, id, entry, () => {}, true);
  }
  private ack(ack: AdapterAck): void {
    if (!this.active) return;
    const at = this.now(), id = ack.refId;
    const entry = this.pending.get(id);
    if (entry && this.take(this.pending, id, entry)) {
      if (at < entry.deadline) entry.resolve(ack);
      else {
        // The first ACK itself can observe expiry before the timer runs.
        entry.reject(new Error('timeout; outcome unknown'));
        if (ack.ok && entry.observeLate && at < entry.deadline + LATE_ACK_WINDOW_MS) void entry.observeLate(ack);
      }
      return;
    }
    const late = this.lateAcks.get(id);
    if (late && this.take(this.lateAcks, id, late) && ack.ok && at < late.deadline) void late.observe(ack);
  }
  private writeAck(ack: AdapterAck): void {
    this.socket.write(encodeIpcFrame({type:1,data:encodeAdapterJson({v:1,type:'ack',id:'ipc_'+ulid(),ts:Date.now(),payload:ack})}));
  }
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.step = null;
    for (const [id, entry] of this.pending) {
      if (this.take(this.pending, id, entry)) entry.reject(new Error('disconnected; outcome unknown'));
    }
    for (const [id, entry] of this.lateAcks) this.take(this.lateAcks, id, entry);
    try { this.socket.destroy(); } finally { this.closed(); }
  }
}
