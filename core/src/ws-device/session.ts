import { id, parseDeviceMessage, timestamp } from '@voipgw/protocol';
import { ulid } from 'ulid';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { tokenHash } from '../auth/service.js';
import type { DeviceProtocolAlertObserver, DeviceProtocolObservation } from '../devices/protocol-alerts.js';
import type {DeviceCommands} from './commands.js';

// The normal hello parser still owns admission. Only identify a 4005 from a
// recognizable hello carrying an explicit, unsupported protocol major.
const mismatchHello = z.object({
  v: z.literal(1), type: z.literal('hello'), id: id('evt'), ts: timestamp,
  payload: z.object({ token: z.string().min(1), protocol: z.number().int().nonnegative().refine(major => major !== 1) }),
});
const HELLO_TIMEOUT_MS = 5_000;
const OBSERVATION_WINDOW_MS = 5_000;
const MAX_MISMATCH_CHECKS = 2;
const MAX_PROTOCOL_OBSERVATIONS = 32;

export interface DeviceSocket { send(data:string):void; close(code:number):void; readonly readyState?: number }
const socketIsOpen = (socket: DeviceSocket) => socket.readyState === undefined || socket.readyState === 1; // WebSocket.OPEN
export interface AuthenticatedDeviceEventContext {
  callGeneration: boolean;
  connectionId: string;
  isCurrent(): boolean;
}
export interface DeviceSessionDeps {
  authenticate(token: string): Promise<{ id: string; enabled: boolean } | null>;
  heartbeat(id: string, payload: unknown, observedAt: number): Promise<void>;
  onEvent(id: string, event: unknown, context: AuthenticatedDeviceEventContext): Promise<boolean>;
  heartbeatSec: number;
  locale: string;
  currentConfig?: () => Promise<{ heartbeatSec: number; locale: string }>;
  commands?: DeviceCommands;
  protocolAlerts?: DeviceProtocolAlertObserver;
}

interface SessionState {
  socket: DeviceSocket;
  deviceId: string | null;
  generation: number | null;
  eventContext: AuthenticatedDeviceEventContext | null;
  closed: boolean;
  pending: number;
  queue: Promise<void>;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class DeviceSessions {
  private readonly active = new Map<string, DeviceSocket>();
  private readonly activeGenerations = new Map<string, number>();
  // Process-local FIFO for attachment replacement, heartbeats and call events.
  // SMS events and command ACKs are independent of this lane.
  private readonly deviceLanes = new Map<string, Promise<void>>();

  private async inDeviceLane<T>(id:string, work:()=>Promise<T>|T):Promise<T> {
    const previous = this.deviceLanes.get(id) ?? Promise.resolve();
    const result = previous.then(work);
    const tail = result.then(() => {}, () => {});
    this.deviceLanes.set(id, tail);
    try { return await result; }
    finally { if (this.deviceLanes.get(id) === tail) this.deviceLanes.delete(id); }
  }
  // A closed socket can still have asynchronous work in flight.
  private readonly sessions = new Set<SessionState>();
  // Until every potentially unauthenticated message settles, its device is unknown.
  private handshakeCandidates = 0;
  private admissionSequence = 0;
  private readonly latestAuthenticated = new Map<string, number>();
  private revocationEpoch = 0;
  private readonly revocations = new Map<string, {epoch:number; code:4010|4011}>();
  private stopping = false;
  private readonly cleanupErrors: unknown[] = [];
  private stopPromise?: Promise<void>;
  // One bounded alert writer, independent of device traffic and attachment replacement.
  private protocolTail = Promise.resolve();
  private pendingProtocolObservations = 0;
  private mismatchChecks = 0;
  private protocolSequence = 0;
  // Keep confirmation history only while a rejected hello is being observed.
  private readonly latestCompatible = new Map<string, number>();
  constructor(private readonly deps:DeviceSessionDeps) {}

  private revokedSince(deviceId: string, epoch: number): 4010 | 4011 | undefined {
    const latest = this.revocations.get(deviceId);
    return latest && latest.epoch > epoch ? latest.code : undefined;
  }

  private queueProtocolObservation(kind: DeviceProtocolObservation['kind'], deviceId: string, token: string,
    isEligible: () => boolean, until = performance.now() + OBSERVATION_WINDOW_MS): Promise<void> | undefined {
    const observer = this.deps.protocolAlerts;
    const isCurrent = () => !this.stopping && performance.now() < until && isEligible();
    if (!observer || this.pendingProtocolObservations >= MAX_PROTOCOL_OBSERVATIONS || !isCurrent()) return;
    const credentialHash = tokenHash(token);
    this.pendingProtocolObservations++;
    const work = this.protocolTail.then(async () => {
      if (isCurrent()) await observer.observe({ kind, deviceId, credentialHash, isCurrent });
    }).catch(() => {
      // Diagnostic failure is not a wire error or evidence of a changed episode.
    }).finally(() => { this.pendingProtocolObservations--; });
    this.protocolTail = work;
    return work;
  }

  private async observeMismatch(token: string, authEpoch: number): Promise<void> {
    // The 4005 has already been sent. Do not let rejected sockets fill the auth pool.
    if (this.stopping || this.mismatchChecks >= MAX_MISMATCH_CHECKS) return;
    this.mismatchChecks++;
    const sequence = ++this.protocolSequence;
    const until = performance.now() + OBSERVATION_WINDOW_MS;
    try {
      const device = await this.deps.authenticate(token);
      if (!device?.enabled) return;
      await this.queueProtocolObservation('mismatch', device.id, token, () =>
        !this.revokedSince(device.id, authEpoch) && (this.latestCompatible.get(device.id) ?? 0) < sequence, until);
    } catch {
      // An unavailable authority is not mismatch evidence.
    } finally { if (--this.mismatchChecks === 0) this.latestCompatible.clear(); }
  }

  private detach(state: SessionState): void {
    state.closed = true;
    if (state.timer !== undefined) clearTimeout(state.timer);
    state.timer = undefined;
    if (state.deviceId && this.active.get(state.deviceId) === state.socket) {
      this.active.delete(state.deviceId);
      this.activeGenerations.delete(state.deviceId);
      try { this.deps.commands?.detach(state.deviceId, state.socket); }
      catch (error) { this.cleanupErrors.push(error); throw error; }
    }
    if (state.pending === 0) this.sessions.delete(state);
  }

  revoke(id:string, code:4010|4011=4010):void {
    const epoch = ++this.revocationEpoch;
    if (this.handshakeCandidates > 0) this.revocations.set(id, {epoch, code});
    const socket = this.active.get(id);
    if (socket) {
      const state = [...this.sessions].find(s => s.socket === socket);
      const errors: unknown[] = [];
      try { if (state) this.detach(state); } catch (error) { errors.push(error); }
      try { socket.close(code); } catch (error) { this.cleanupErrors.push(error); errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'device revocation cleanup failed');
    }
  }

  /** Stop admission and drain queues, then request socket closure; does not await transport close. */
  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    const states = [...this.sessions];
    for (const state of states) {
      if (state.timer !== undefined) clearTimeout(state.timer);
      state.timer = undefined;
    }
    this.stopPromise = (async () => {
      const results = await Promise.allSettled([...states.map(state => state.queue), this.protocolTail]);
      const errors: unknown[] = results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason);
      for (const state of states) {
        const wasClosed = state.closed;
        try { this.detach(state); } catch (error) { errors.push(error); }
        if (!wasClosed) {
          try { state.socket.close(1001); } catch (error) { errors.push(error); }
        }
      }
      errors.push(...this.cleanupErrors);
      if (errors.length) throw new AggregateError(errors, 'device session shutdown failed');
    })();
    return this.stopPromise;
  }

  open(socket:DeviceSocket) {
    if (this.stopping) {
      socket.close(1001);
      return { close: () => {}, message: (_raw:string) => Promise.resolve() };
    }
    const state: SessionState = {socket, deviceId:null, generation:null, eventContext:null, closed:false, pending:0, queue:Promise.resolve(), timer:undefined};
    this.sessions.add(state);
    state.timer = setTimeout(() => {
      if (!state.deviceId && !state.closed) {
        this.detach(state);
        socket.close(4001);
      }
    }, HELLO_TIMEOUT_MS);
    const closeWith = (code:number) => { this.detach(state); socket.close(code); };
    return {
      close: () => this.detach(state),
      message: (raw:string):Promise<void> => {
        if (this.stopping || state.closed) return Promise.resolve();
        if (state.pending >= 64) { closeWith(1013); return Promise.resolve(); }
        const admission = ++this.admissionSequence;
        const handshakeCandidate = !state.deviceId;
        if (handshakeCandidate) this.handshakeCandidates++;
        state.pending++;
        const task = state.queue.then(async () => {
          if (state.closed) return;
          try {
            let value:unknown;
            try { value = JSON.parse(raw); } catch { closeWith(4003); return; }
            if (!state.deviceId) {
              const candidate=value as {payload?:{protocol?:unknown}};
              if (candidate?.payload?.protocol !== 1) {
                const observation = this.deps.protocolAlerts ? mismatchHello.safeParse(value) : null;
                const authEpoch = this.revocationEpoch;
                closeWith(4005);
                if (observation?.success) await this.observeMismatch(observation.data.payload.token, authEpoch);
                return;
              }
              let msg;
              try { msg=parseDeviceMessage(value,'event'); } catch { closeWith(4003); return; }
              if (msg.type !== 'hello') { closeWith(4003); return; }
              const authEpoch = this.revocationEpoch;
              const hello = msg.payload as { token: string; capabilities?: { callGeneration?: boolean } };
              const device=await this.deps.authenticate(hello.token);
              if (state.closed) return;
              if (!device) { closeWith(4003); return; }
              if (!device.enabled) { closeWith(4011); return; }
              const revoked = () => this.revokedSince(device.id, authEpoch);
              const revokedDuringAuth=revoked();
              if (revokedDuringAuth) { closeWith(revokedDuringAuth); return; }
              if ((this.latestAuthenticated.get(device.id) ?? 0) > admission) { closeWith(4009); return; }
              this.latestAuthenticated.set(device.id, admission);
              state.deviceId=device.id;
              if (state.timer !== undefined) clearTimeout(state.timer);
              state.timer=undefined;
              const config=this.deps.currentConfig ? await this.deps.currentConfig() : {heartbeatSec:this.deps.heartbeatSec,locale:this.deps.locale};
              await this.inDeviceLane(device.id, () => {
                const stillEligible = () => {
                  if (state.closed) return false;
                  const code=revoked();
                  if (code) { closeWith(code); return false; }
                  if (this.latestAuthenticated.get(device.id) !== admission) { closeWith(4009); return false; }
                  return true;
                };
                if (!stillEligible()) return;
                const oldSocket=this.active.get(device.id);
                if (oldSocket) {
                  const oldState=[...this.sessions].find(s => s.socket === oldSocket);
                  if (oldState) this.detach(oldState);
                  oldSocket.close(4009);
                  // detach/close are synchronous but can reenter user callbacks.
                  if (!stillEligible()) return;
                }
                state.generation=admission;
                state.eventContext = {
                  callGeneration: hello.capabilities?.callGeneration === true,
                  connectionId: randomUUID(),
                  isCurrent: () => !state.closed &&
                    this.active.get(device.id) === socket && this.activeGenerations.get(device.id) === admission,
                };
                this.active.set(device.id,socket);
                this.activeGenerations.set(device.id,admission);
                const { callGeneration, connectionId, isCurrent } = state.eventContext;
                if (callGeneration) this.deps.commands?.attach(device.id, socket, { connectionId, current: isCurrent });
                else this.deps.commands?.attach(device.id, socket);
                if (isCurrent()) {
                  const wasOpen = socketIsOpen(socket);
                  socket.send(JSON.stringify({v:1,type:'hello.ok',id:'cmd_'+ulid(),ts:Date.now(),payload:{deviceId:device.id,serverTime:Date.now(),config}}));
                  const confirmed = () => isCurrent() && socketIsOpen(socket);
                  if (wasOpen && confirmed()) {
                    this.deps.commands?.configReady(device.id, socket);
                    // Compare actual confirmation with rejection, not order of hello arrival or auth.
                    if (this.mismatchChecks > 0) this.latestCompatible.set(device.id, ++this.protocolSequence);
                    this.queueProtocolObservation('compatible', device.id, hello.token, confirmed);
                  }
                }
              });
              return;
            }
            if (this.active.get(state.deviceId) !== socket) return;
            let msg;
            try { msg=parseDeviceMessage(value,'event'); } catch { return; }
            if (msg.type === 'ack') { this.deps.commands?.acknowledge(state.deviceId,msg.payload as {refId:string;ok:boolean;error:string|null}); return; }
            if (msg.type === 'heartbeat') {
              const deviceId=state.deviceId, generation=state.generation;
              await this.inDeviceLane(deviceId, async () => {
                if (state.closed || generation === null || this.active.get(deviceId) !== socket || this.activeGenerations.get(deviceId) !== generation) return;
                await this.deps.heartbeat(deviceId,msg.payload,msg.ts);
              });
            }
            else if (state.eventContext) {
              const { deviceId, eventContext } = state;
              const handle = () => eventContext.isCurrent() && this.deps.onEvent(deviceId, msg, eventContext);
              // An authenticated replacement waits for a previously admitted call
              // transaction to settle. Command ACKs are processed independently.
              const accepted = msg.type === 'call.incoming' || msg.type === 'call.state'
                ? await this.inDeviceLane(deviceId, handle)
                : await handle();
              if (accepted && eventContext.isCurrent()) {
                socket.send(JSON.stringify({v:1,type:'ack',id:'cmd_'+ulid(),ts:Date.now(),payload:{refId:msg.id,ok:true,error:null}}));
              }
            }
          } catch { if (!state.closed) closeWith(1011); }
        });
        state.queue=task.finally(() => {
          state.pending--;
          if (handshakeCandidate && --this.handshakeCandidates === 0) {
            this.latestAuthenticated.clear();
            this.revocations.clear();
          }
          if (state.closed && state.pending === 0) this.sessions.delete(state);
        });
        return state.queue;
      }
    };
  }
}
