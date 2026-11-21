import { parseDeviceMessage } from '@voipgw/protocol';
import { ulid } from 'ulid';
import { allocateSmsCommandId, isSmsCommandId } from '../sms/attempt-id.js';
import type { SmsCommandAck } from '../sms/dispatch.js';
import type { DeviceSocket } from './session.js';
import type { ConfigAttachment } from '../settings/device-config.js';

const ACK_TIMEOUT_MS = 10_000;

type Attachment = { socket: DeviceSocket; call?: { connectionId: string; current(): boolean }; config?: ConfigAttachment };
export type CallCommand = 'call.dial' | 'call.answer' | 'call.reject' | 'call.hangup' | 'call.dtmf';
export interface CurrentCallAttachment {
  connectionId: string;
  current(): boolean;
  prepare(type: CallCommand, payload: unknown): { commandId: string; send(): Promise<SmsCommandAck> };
}
type PendingCommand = {
  deviceId: string;
  attachment: Attachment;
  resolve: (value: SmsCommandAck) => void;
  reject: (error: unknown) => void;
  deadline: number | undefined;
  timer: ReturnType<typeof setTimeout> | undefined;
};
type SmsPayload = { taskId: string; subId: number | null; slot: number; to: string; body: string };

export class DeviceCommands {
  private readonly sockets = new Map<string, Attachment>();
  private readonly pending = new Map<string, PendingCommand>();

  constructor(private readonly beforeSend: () => void = () => {},
    private readonly now: () => number = () => performance.now()) {}

  isConnected(id: string): boolean { return this.sockets.has(id); }
  /** A config target becomes eligible only after this socket sent hello.ok. */
  configReady(deviceId: string, socket: DeviceSocket): void {
    const attachment = this.sockets.get(deviceId);
    if (!attachment || attachment.socket !== socket || attachment.config) return;
    const current = () => this.sockets.get(deviceId) === attachment && (socket.readyState === undefined || socket.readyState === 1);
    if (!current()) return;
    attachment.config = {
      deviceId,
      current,
      send: (payload, allowed) => this.sendOrdinaryOn(deviceId, attachment, 'config.update', payload, () => current() && allowed()),
    };
  }

  configAttachments(): readonly ConfigAttachment[] {
    return [...this.sockets.values()].flatMap(attachment => attachment.config?.current() ? [attachment.config] : []);
  }

  attach(id: string, socket: DeviceSocket, call?: Attachment['call']): void {
    const previous = this.sockets.get(id);
    if (previous) this.rejectPending(previous);
    this.sockets.set(id, { socket, call });
  }

  detach(id: string, socket: DeviceSocket): void {
    const attachment = this.sockets.get(id);
    if (!attachment || attachment.socket !== socket) return;
    this.sockets.delete(id);
    this.rejectPending(attachment);
  }

  private rejectPending(attachment: Attachment): void {
    for (const [id, pending] of this.pending) {
      if (pending.attachment === attachment && this.takePending(id, pending)) pending.reject(new Error('disconnected'));
    }
  }

  /** Caller must obtain a confirmed, matching durable claim before invoking send. */
  prepareSms(deviceId: string, payload: SmsPayload): { commandId: string; send(): Promise<SmsCommandAck> } | null {
    this.beforeSend();
    const attachment = this.sockets.get(deviceId);
    if (!attachment) return null;
    const commandId = allocateSmsCommandId();
    const envelope = parseDeviceMessage({ v: 1, type: 'sms.send', id: commandId, ts: Date.now(), payload }, 'command');
    let used = false;
    return {
      commandId,
      send: () => {
        if (used) return Promise.reject(new Error('SMS command has already been attempted'));
        used = true;
        return this.sendOn(deviceId, attachment, commandId, JSON.stringify({ ...envelope, ts: Date.now() }));
      },
    };
  }

  /** This describes the current negotiated socket. The caller supplies independent
   * device authorization before using it for an external action. */
  captureCallAttachment(deviceId: string): CurrentCallAttachment | null {
    const attachment = this.sockets.get(deviceId);
    const authority = attachment?.call;
    if (!attachment || !authority) return null;
    const current = () => this.sockets.get(deviceId) === attachment && authority.current();
    if (!current()) return null;
    return {
      connectionId: authority.connectionId,
      current,
      prepare: (type, payload) => {
        this.beforeSend();
        if (!current()) throw new Error('Call attachment is no longer current');
        const commandId = 'cmd_' + ulid();
        if (isSmsCommandId(commandId)) throw new Error('Invalid call command ID');
        const frame = parseDeviceMessage({ v: 1, type, id: commandId, ts: Date.now(), payload }, 'command');
        if (!(frame.payload as {generation?: string}).generation) throw new Error('Call generation is required');
        let used = false;
        return {
          commandId,
          send: () => {
            if (used) return Promise.reject(new Error('Call command cannot be submitted'));
            used = true;
            return this.sendOn(deviceId, attachment, commandId, JSON.stringify({ ...frame, ts: Date.now() }), current);
          },
        };
      },
    };
  }

  send(deviceId: string, type: string, payload: unknown): Promise<SmsCommandAck> {
    if (type === 'sms.send' || type.startsWith('call.')) return Promise.reject(new Error('Action requires a prepared command'));
    if (type === 'config.update') return Promise.reject(new Error('Configuration requires an eligible attachment'));
    const attachment = this.sockets.get(deviceId);
    if (!attachment) return Promise.reject(new Error('offline'));
    return this.sendOrdinaryOn(deviceId, attachment, type, payload);
  }

  private sendOrdinaryOn(deviceId: string, attachment: Attachment, type: string, payload: unknown, current?: () => boolean): Promise<SmsCommandAck> {
    const id = 'cmd_' + ulid();
    if (isSmsCommandId(id)) return Promise.reject(new Error('Ordinary command ID is in the SMS range'));
    let frame: string;
    try { frame = JSON.stringify({ v: 1, type, id, ts: Date.now(), payload }); }
    catch { return Promise.reject(new Error('send failed')); }
    return this.sendOn(deviceId, attachment, id, frame, current);
  }

  private takePending(id: string, pending: PendingCommand): boolean {
    // A retired timer or a reentrant send cleanup cannot settle a different attempt.
    if (this.pending.get(id) !== pending) return false;
    this.pending.delete(id);
    if (pending.timer !== undefined) clearTimeout(pending.timer);
    pending.timer = undefined;
    return true;
  }

  private expire(id: string, pending: PendingCommand): void {
    if (this.takePending(id, pending)) pending.reject(new Error('timeout'));
  }

  private sendOn(deviceId: string, attachment: Attachment, id: string, frame: string, current?: () => boolean): Promise<SmsCommandAck> {
    if (this.sockets.get(deviceId) !== attachment) return Promise.reject(new Error('disconnected'));
    if (this.pending.has(id)) return Promise.reject(new Error('Command ID is already pending'));
    return new Promise((resolve, reject) => {
      const pending: PendingCommand = { deviceId, attachment, resolve, reject, deadline: undefined, timer: undefined };
      this.pending.set(id, pending);
      try {
        this.beforeSend();
        // Do not let a transport method lookup admit an ACK or bypass the final gate.
        const socket = attachment.socket;
        const send = socket.send;
        if (current && !current()) throw new Error('disconnected');
        const ready = socket.readyState;
        const deadline = this.now() + ACK_TIMEOUT_MS;
        if (this.pending.get(id) !== pending || this.sockets.get(deviceId) !== attachment || (ready !== undefined && ready !== 1)) throw new Error('disconnected');
        pending.deadline = deadline;
        try { Reflect.apply(send, socket, [frame]); }
        catch { throw new Error('send failed'); }
        // The transport may have settled the command synchronously during send.
        const checkDeadline = () => {
          if (this.pending.get(id) !== pending) return;
          const remaining = deadline - this.now();
          if (remaining <= 0) this.expire(id, pending);
          else pending.timer = setTimeout(checkDeadline, Math.ceil(remaining));
        };
        checkDeadline();
      } catch (error) {
        if (this.takePending(id, pending)) reject(error);
      }
    });
  }

  /** ACK acceptance is local, not proof of completion of the external action. */
  acknowledge(deviceId: string, socket: DeviceSocket, ack: SmsCommandAck & { refId: string }): void {
    const pending = this.pending.get(ack.refId);
    if (!pending || pending.deadline === undefined || pending.deviceId !== deviceId || pending.attachment.socket !== socket || this.sockets.get(deviceId) !== pending.attachment) return;
    if (this.now() >= pending.deadline) { this.expire(ack.refId, pending); return; }
    if (this.takePending(ack.refId, pending)) pending.resolve({ ok: ack.ok, error: ack.error });
  }
}
