import { ulid } from 'ulid';
import { MEDIA_FLAGS } from '@voipgw/protocol';
import type { MediaLeg } from '../media/leg.js';
import { MediaRouter } from '../media/router.js';
import type { MediaTransport } from '../media/transport.js';
import type { CurrentCallAttachment } from '../ws-device/commands.js';
import { CallRequestError, type PgWebCallStore, type WebCallIds, type WebCallRecord,
  type WebCallRequest, type WebCallSim } from './web-call-store.js';

type Phase = 'waiting' | 'dialing' | 'bridged' | 'ending';
type BrowserLeg = { legId: string; mediaPath: string; mediaToken: string };
type CreationAdmission = { owner: string; request: WebCallRequest; revoked: boolean };
type Reservation = { session: unknown; browserLeg: BrowserLeg };
const OWNER_PROOF_MS = 2_000;
type LiveCall = {
  ids: WebCallIds; request: WebCallRequest; owner: string; sim: WebCallSim;
  attachment: CurrentCallAttachment; browserLeg: BrowserLeg; browser: MediaLeg;
  cell: MediaLeg; router: MediaRouter; phase: Phase; deadline: number;
  nextCheck: number; work?: Promise<unknown>; controlWork?: Promise<void>; revoked: boolean;
  ownerUntil: number; hangupRequested: boolean;
};

type CallStore = Pick<PgWebCallStore, 'find' | 'locateSim' | 'reserve' | 'compensateReservation' | 'arm' | 'acknowledge' | 'situation' | 'bridge' | 'finish'>;
interface WebCallsOptions {
  store: CallStore;
  media: MediaTransport;
  capture(deviceId: string): CurrentCallAttachment | null;
  summary(sessionId: string): Promise<unknown | null>;
  authorizeOwner(owner: string): Promise<number | null>;
  update(sessionId: string): void;
  clock?: () => number;
  automatic?: boolean;
  reportFailure?: () => void;
}

function mediaPath(session: string, leg: string): string {
  return '/ws/media?' + new URLSearchParams({ session, leg });
}

export class WebCalls {
  private readonly live = new Map<string, LiveCall>();
  private readonly creations = new Map<string, { gate: CreationAdmission; work: Promise<Reservation> }>();
  private readonly clock: () => number;
  private readonly timer?: ReturnType<typeof setInterval>;
  private closing = false;
  private stopped?: Promise<void>;

  constructor(private readonly deps: WebCallsOptions) {
    this.clock = deps.clock ?? Date.now;
    if (deps.automatic !== false) this.timer = setInterval(() => this.tick(), 20);
  }

  create(request: WebCallRequest, owner: string): Promise<{ session: unknown; browserLeg: BrowserLeg }> {
    if (this.closing) return Promise.reject(new CallRequestError('CAPABILITY_UNSUPPORTED'));
    const pending = this.creations.get(request.key);
    if (pending) {
      if (pending.gate.owner !== owner || pending.gate.revoked || pending.gate.request.simId !== request.simId || pending.gate.request.to !== request.to) {
        return Promise.reject(new CallRequestError('CONFLICT'));
      }
      return pending.work;
    }
    const gate = { owner, request, revoked: false };
    const work = Promise.resolve().then(() => this.createOnce(gate)).finally(() => this.creations.delete(request.key));
    this.creations.set(request.key, { gate, work });
    return work;
  }

  private async createOnce(gate: CreationAdmission): Promise<Reservation> {
    const { request, owner } = gate;
    const { store, media } = this.deps;
    const allowed = () => !this.closing && !gate.revoked;
    const previous = await store.find(request.key);
    if (previous) return this.original(previous, gate);
    const deviceId = await store.locateSim(request.simId);
    if (!deviceId) throw new CallRequestError('SIM_NOT_FOUND', 404);
    const attachment = this.deps.capture(deviceId);
    if (!attachment?.current() || !allowed()) throw new CallRequestError('CAPABILITY_UNSUPPORTED');
    const ids = { deviceId, id: 'ses_' + ulid(), browserLegId: 'leg_' + ulid(),
      cellularLegId: 'leg_' + ulid(), callId: 'cal_' + ulid(), generation: 'gen_' + ulid(), connectionId: attachment.connectionId };
    let entry: LiveCall | undefined;
    const current = () => allowed() && !entry?.revoked && attachment.current();
    let ownerUntil = await this.ownerProof(owner, current);
    if (ownerUntil === null) throw new CallRequestError('CAPABILITY_UNSUPPORTED');
    let reserved: Awaited<ReturnType<CallStore['reserve']>>;
    try { reserved = await store.reserve(ids, request, current); }
    catch (error) {
      if (!(error instanceof CallRequestError)) {
        try { await store.compensateReservation(ids, request.key); }
        catch { this.deps.reportFailure?.(); }
      }
      throw error;
    }
    if ('existing' in reserved) return this.original(reserved.existing, gate);
    try {
      ownerUntil = await this.ownerProof(owner, current);
      if (ownerUntil === null) throw new CallRequestError('CAPABILITY_UNSUPPORTED');
      const mediaCurrent = () => !!entry && this.ownerCurrent(entry) && !entry.hangupRequested;
      const browser = media.provision(ids.id, ids.browserLegId, { kind: 'browser', current: mediaCurrent });
      const cell = media.provision(ids.id, ids.cellularLegId, { kind: 'device', deviceId, current: mediaCurrent });
      if (!browser.mediaToken) throw new Error('Browser media token unavailable');
      const browserLeg = { legId: ids.browserLegId, mediaPath: mediaPath(ids.id, ids.browserLegId), mediaToken: browser.mediaToken };
      entry = { ids, request, owner, attachment, sim: reserved.sim, browserLeg,
        browser: browser.leg, cell: cell.leg, router: new MediaRouter(browser.leg, cell.leg),
        phase: 'waiting', deadline: this.clock() + 10_000, nextCheck: 0, revoked: false, ownerUntil, hangupRequested: false };
      this.live.set(ids.id, entry);
      const session = await this.deps.summary(ids.id);
      if (!session || !current() || !this.ownerCurrent(entry)) throw new CallRequestError('TIMEOUT_UNKNOWN', 504);
      this.deps.update(ids.id);
      return { session, browserLeg };
    } catch (error) {
      if (entry) await this.closeCall(entry, 'browser_provision_failed');
      else {
        this.revokeLegs(ids);
        await store.finish(ids, 'browser_provision_failed');
      }
      throw error;
    }
  }

  private async original(row: WebCallRecord, gate: CreationAdmission): Promise<Reservation> {
    const { request, owner } = gate;
    if (row.kind !== 'web_out' || row.simId !== request.simId || row.to !== request.to) throw new CallRequestError('CONFLICT');
    const active = this.live.get(row.id);
    if (!active || active.owner !== owner || !this.current(active)) throw new CallRequestError('TIMEOUT_UNKNOWN', 504);
    const session = await this.deps.summary(row.id);
    if (!session || gate.revoked || !await this.refreshOwner(active) || gate.revoked || active.hangupRequested ||
        this.deps.media.status(row.id, active.ids.browserLegId).hasAttached) {
      throw new CallRequestError('TIMEOUT_UNKNOWN', 504);
    }
    return { session, browserLeg: active.browserLeg };
  }

  private current(entry: LiveCall): boolean {
    return !this.closing && !entry.revoked && this.live.get(entry.ids.id) === entry && entry.attachment.current();
  }

  private ownerCurrent(entry: LiveCall): boolean {
    return this.current(entry) && this.clock() < entry.ownerUntil;
  }

  private async ownerProof(owner: string, current: () => boolean): Promise<number | null> {
    if (!current()) return null;
    const startedAt = this.clock();
    const expiresAt = await this.deps.authorizeOwner(owner);
    const now = this.clock();
    const until = Math.min(expiresAt ?? 0, startedAt + OWNER_PROOF_MS);
    return Number.isFinite(until) && now >= startedAt && now < until && current() ? until : null;
  }

  private async refreshOwner(entry: LiveCall): Promise<boolean> {
    const until = await this.ownerProof(entry.owner, () => this.current(entry));
    if (until === null) return false;
    entry.ownerUntil = until;
    return true;
  }

  private run<T>(entry: LiveCall, act: () => Promise<T>): Promise<T> | undefined {
    if (entry.work) return undefined;
    const work = Promise.resolve().then(act).finally(() => { entry.work = undefined; });
    entry.work = work;
    return work;
  }

  tick(now = this.clock()): void {
    if (this.closing) return;
    for (const entry of this.live.values()) {
      const browser = this.deps.media.status(entry.ids.id, entry.ids.browserLegId, now);
      const cell = this.deps.media.status(entry.ids.id, entry.ids.cellularLegId, now);
      try {
        if (this.ownerCurrent(entry) && !entry.hangupRequested && browser.attached && cell.attached) {
          if (entry.phase === 'bridged') entry.router.tick(now);
          else if (entry.phase === 'dialing') {
            entry.cell.checkStalled(now);
            const audio = entry.cell.read();
            const flags = audio.flags & (MEDIA_FLAGS.earlyMedia | MEDIA_FLAGS.silence);
            if (flags & MEDIA_FLAGS.earlyMedia) entry.browser.write(audio.pcm, flags, now);
          }
        }
      } catch { entry.revoked = true; }
      if (now < entry.nextCheck || entry.controlWork) continue;
      const work = this.run(entry, async () => {
        try { await this.advance(entry, now); }
        catch {
          this.deps.reportFailure?.();
          await this.closeCall(entry, 'call_progress_unconfirmed');
        }
      });
      if (!work) continue;
      entry.nextCheck = now + 250;
      void work.catch(() => this.deps.reportFailure?.());
    }
  }

  private async advance(entry: LiveCall, now: number): Promise<void> {
    if (!this.current(entry)) return this.closeCall(entry, 'call_attachment_lost');
    if (!await this.refreshOwner(entry)) return this.closeCall(entry, 'call_owner_unavailable');
    const { ids, phase } = entry;
    const row = await this.deps.store.situation(ids);
    // An explicit hangup owns the next transition. Its synchronous media gate
    // must not be interpreted as a disconnect by this older progress pass.
    if (entry.hangupRequested && phase !== 'ending') return;
    if (!row || row.state === 'ended' || row.state === 'unknown' || !this.current(entry)) {
      return this.closeCall(entry, 'call_ended_or_unconfirmed');
    }
    const browser = this.deps.media.status(ids.id, ids.browserLegId);
    const cell = this.deps.media.status(ids.id, ids.cellularLegId);
    if (phase === 'waiting') {
      if (now >= entry.deadline || (browser.hasAttached && !browser.attached)) return this.closeCall(entry, 'browser_media_timeout');
      if (browser.ready && row.state === 'awaiting_browser') await this.dial(entry);
      return;
    }
    if (phase === 'ending') {
      if (now >= entry.deadline) await this.closeCall(entry, 'hangup_unconfirmed');
      return;
    }
    if (!browser.attached || (cell.hasAttached && !cell.attached) || now >= entry.deadline) {
      if (row.ack === 'ok') await this.submitControl(entry, 'call.hangup');
      else await this.closeCall(entry, 'call_media_lost');
      return;
    }
    if (phase === 'dialing' && row.legState === 'active' && row.ack === 'ok' && browser.ready && cell.ready) {
      const ready = () => this.ownerCurrent(entry) && !entry.hangupRequested && this.deps.media.status(ids.id, ids.browserLegId).ready
        && this.deps.media.status(ids.id, ids.cellularLegId).ready;
      if (await this.deps.store.bridge(ids, ready)) {
        entry.phase = 'bridged';
        if (entry.hangupRequested) return;
        if (!ready()) return this.closeCall(entry, 'media_lost_during_bridge');
        entry.deadline = this.clock() + 4 * 60 * 60 * 1000;
        this.deps.update(ids.id);
      }
    }
  }

  private async dial(entry: LiveCall): Promise<void> {
    const { ids, sim } = entry;
    const prepared = entry.attachment.prepare('call.dial', {
      callId: ids.callId, generation: ids.generation, to: entry.request.to, ...sim,
      media: { sessionId: ids.id, legId: ids.cellularLegId, path: mediaPath(ids.id, ids.cellularLegId), format: 2 },
    });
    const ready = () => this.ownerCurrent(entry) && !entry.hangupRequested && this.clock() < entry.deadline &&
      this.deps.media.status(ids.id, ids.browserLegId).ready;
    if (entry.hangupRequested) return;
    if (!await this.refreshOwner(entry)) return this.closeCall(entry, 'dial_admission_changed');
    if (entry.hangupRequested) return;
    if (!ready()) return this.closeCall(entry, 'dial_admission_changed');
    if (!await this.deps.store.arm(ids, entry.request.simId, sim, prepared.commandId, ready)) return;
    let sendAuthorized = false;
    try { sendAuthorized = !entry.hangupRequested && await this.refreshOwner(entry) && ready(); } catch { /* no proof */ }
    if (!sendAuthorized) {
      await this.deps.store.acknowledge(ids, prepared.commandId, 'unknown');
      return this.closeCall(entry, 'dial_admission_changed');
    }
    entry.phase = 'dialing';
    entry.deadline = this.clock() + 60_000;
    let result: 'ok' | 'error' | 'unknown' = 'unknown';
    try { result = (await prepared.send()).ok ? 'ok' : 'error'; } catch { /* A failed send can have crossed the boundary. */ }
    await this.deps.store.acknowledge(ids, prepared.commandId, result);
    this.deps.update(ids.id);
    if (result !== 'ok') await this.closeCall(entry, 'dial_outcome_unconfirmed');
  }

  control(sessionId: string, owner: string, type: 'call.hangup' | 'call.dtmf', digits?: string): Promise<void> {
    const entry = this.live.get(sessionId);
    if (!entry || entry.owner !== owner || !this.current(entry)) return Promise.reject(new CallRequestError('CAPABILITY_UNSUPPORTED'));
    if (entry.controlWork || entry.hangupRequested || (type === 'call.dtmf' && entry.work)) {
      return Promise.reject(new CallRequestError('DEVICE_BUSY'));
    }
    const previous = entry.work;
    // Stop progression/audio immediately on an explicitly requested hangup,
    // then serialize its one send behind the transition already in flight.
    if (type === 'call.hangup') entry.hangupRequested = true;
    const work = Promise.resolve(previous).catch(() => {}).then(async () => {
      if (!this.current(entry)) {
        if (type === 'call.hangup' && this.live.get(entry.ids.id) !== entry) throw new CallRequestError('CALL_NOT_ACTIVE');
        throw new CallRequestError('CAPABILITY_UNSUPPORTED');
      }
      if (!await this.refreshOwner(entry)) {
        await this.closeCall(entry, 'call_owner_unavailable');
        throw new CallRequestError('CAPABILITY_UNSUPPORTED');
      }
      try { await this.submitControl(entry, type, digits); }
      catch (error) {
        if (type === 'call.hangup' && !entry.revoked && entry.phase !== 'ending') {
          await this.closeCall(entry, 'hangup_unconfirmed');
        }
        throw error;
      }
    }).finally(() => { entry.controlWork = undefined; });
    entry.controlWork = work;
    return work;
  }

  private async submitControl(entry: LiveCall, type: 'call.hangup' | 'call.dtmf', digits?: string): Promise<void> {
    const { ids } = entry;
    if (type === 'call.hangup' && entry.phase === 'waiting') return this.closeCall(entry, 'browser_cancelled');
    const prepared = entry.attachment.prepare(type, { callId: ids.callId, generation: ids.generation,
      ...(type === 'call.dtmf' ? { digits } : {}) });
    const current = () => this.ownerCurrent(entry);
    if (!await this.deps.store.finish(ids, type === 'call.hangup' ? 'browser_requested_hangup' : 'browser_requested_dtmf',
      { type, commandId: prepared.commandId, current })) {
      throw new CallRequestError('CALL_NOT_ACTIVE');
    }
    let allowed = false;
    try { allowed = await this.refreshOwner(entry) && current(); } catch { /* no proof */ }
    if (!allowed) {
      await this.closeCall(entry, 'control_admission_changed');
      throw new CallRequestError('TIMEOUT_UNKNOWN', 504);
    }
    if (type === 'call.hangup') {
      entry.phase = 'ending';
      entry.deadline = this.clock() + 10_000;
    }
    try {
      const ack = await prepared.send();
      if (!ack.ok) throw new Error('Control rejected');
    } catch {
      if (type === 'call.hangup') await this.closeCall(entry, 'hangup_unconfirmed');
      throw new CallRequestError('TIMEOUT_UNKNOWN', 504);
    }
    this.deps.update(ids.id);
  }

  revokeOwner(owner: string): void {
    for (const { gate } of this.creations.values()) if (gate.owner === owner) gate.revoked = true;
    for (const entry of this.live.values()) if (entry.owner === owner) entry.revoked = true;
  }

  revokeAllOwners(): void {
    for (const { gate } of this.creations.values()) gate.revoked = true;
    for (const entry of this.live.values()) entry.revoked = true;
  }

  async closeCall(entry: LiveCall, reason: string): Promise<void> {
    entry.revoked = true;
    this.revokeLegs(entry.ids);
    await this.deps.store.finish(entry.ids, reason);
    if (this.live.get(entry.ids.id) === entry) this.live.delete(entry.ids.id);
    this.deps.update(entry.ids.id);
  }

  private revokeLegs(ids: WebCallIds): void {
    for (const legId of [ids.browserLegId, ids.cellularLegId]) {
      try { this.deps.media.revoke(ids.id, legId); } catch { this.deps.reportFailure?.(); }
    }
  }

  stop(): Promise<void> {
    if (this.stopped) return this.stopped;
    this.closing = true;
    this.revokeAllOwners();
    clearInterval(this.timer);
    this.stopped = (async () => {
      await Promise.allSettled([...this.creations.values()].map(x => x.work));
      const calls = [...this.live.values()];
      await Promise.allSettled(calls.flatMap(x => [x.work, x.controlWork]));
      const closed = await Promise.allSettled(calls.map(x => this.closeCall(x, 'core_stopping')));
      if (closed.some(x => x.status === 'rejected')) throw new Error('Call recovery did not drain');
    })();
    return this.stopped;
  }
}
