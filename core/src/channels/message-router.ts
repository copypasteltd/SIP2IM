import { z } from 'zod';
import { platformMessageIdentity } from '@voipgw/protocol';
import { normalizeNumber } from '../sms/create.js';

export type MessagePlatform = 'qq' | 'telegram';
export const inboundSchema = z.object({
  identity: platformMessageIdentity.optional(), platformMessageId: z.string().min(1), senderId: z.string().min(1), senderName: z.string().nullable(),
  chatType: z.enum(['private', 'group', 'channel']), forwarded: z.boolean(),
  isContact: z.boolean().nullable(), text: z.string(), ts: z.number().int().nonnegative().safe(),
}).strict();
export type InboundMessage = z.infer<typeof inboundSchema>;
export type NumberExpression = { from: string | null; to: string };
export type ParsedCommand = { kind: 'pair'; code: string } | { kind: 'sms'; numbers: NumberExpression; body: string } | { kind: 'call'; numbers: NumberExpression } | { kind: 'usage' } | { kind: 'ignore' };

function numbers(value: string): NumberExpression | null {
  const match = /^([+\d()\-－（）]+)(?:\s*[/／]\s*([+\d()\-－（）]+))?$/.exec(value);
  if (!match) return null;
  const first = normalizeNumber(match[1]!);
  const second = match[2] === undefined ? null : normalizeNumber(match[2]);
  if (!first || (match[2] !== undefined && !second)) return null;
  return second ? { from: first.number, to: second.number } : { from: null, to: first.number };
}

/** Parse only after determining whether the sender is currently paired. */
export function parseInboundCommand(text: string, paired: boolean): ParsedCommand {
  if (!paired) {
    const match = /^\s*(?:绑定\s*)?(\d{8})\s*$/.exec(text);
    return match ? { kind: 'pair', code: match[1]! } : { kind: 'ignore' };
  }
  const trimmed = text.trim();
  const pair = /^绑定\s*(\d{8})$/.exec(trimmed);
  if (pair) return { kind: 'pair', code: pair[1]! };
  const sms = /^(?:短信|sms|SMS)\s+(\S+)\s+([\s\S]+)$/.exec(trimmed);
  if (sms) {
    const parsed = numbers(sms[1]!);
    return parsed ? { kind: 'sms', numbers: parsed, body: sms[2]! } : { kind: 'usage' };
  }
  const parsed = numbers(trimmed);
  return parsed ? { kind: 'call', numbers: parsed } : { kind: 'usage' };
}

export interface MessageRouterDependencies {
  /** Atomically insert direction=in and return false on duplicate (platform, platformMessageId). */
  recordInbound(platform: MessagePlatform, message: InboundMessage): Promise<boolean>;
  isPaired(platform: MessagePlatform, senderId: string): Promise<boolean>;
  /** Atomically enforce 5 failures / 10 minutes, consume a valid code and replace the current pair. */
  pair?(platform: MessagePlatform, senderId: string, code: string, senderName: string | null): Promise<{ status: 'locked' | 'invalid' } | { status: 'ok'; replacedSenderId?: string | null }>;
  notify?(platform: MessagePlatform, senderId: string, template: 'pair_locked' | 'pair_invalid' | 'pair_replaced' | 'pair_ok' | 'pair_ok_add_friend' | 'usage'): Promise<void>;
  /** Implementations must recheck authorization at the point of the side effect. */
  sms?(platform: MessagePlatform, senderId: string, numbers: NumberExpression, body: string, messageId: string): Promise<void>;
  call?(platform: MessagePlatform, senderId: string, numbers: NumberExpression, messageId: string): Promise<void>;
}
export type RouteResult = 'invalid' | 'ignored' | 'duplicate' | 'unavailable' | 'handled';

export class MessageRouter {
  constructor(private readonly deps: MessageRouterDependencies) {}
  async route(platform: unknown, input: unknown): Promise<RouteResult> {
    if (platform !== 'qq' && platform !== 'telegram') return 'invalid';
    const validation = inboundSchema.safeParse(input);
    if (!validation.success) return 'invalid';
    const message = validation.data;
    if (message.chatType !== 'private' || message.forwarded) return 'ignored';
    if (await this.deps.recordInbound(platform, message) !== true) return 'duplicate';
    const paired = await this.deps.isPaired(platform, message.senderId);
    // An invalid authorization result must never grant access.
    if (paired !== true && paired !== false) return 'unavailable';
    const command = parseInboundCommand(message.text, paired);
    if (command.kind === 'ignore') return 'ignored';
    if (command.kind === 'pair') {
      if (!this.deps.pair || !this.deps.notify) return 'unavailable';
      const result = await this.deps.pair(platform, message.senderId, command.code, message.senderName);
      if (result.status === 'locked' || result.status === 'invalid') {
        await this.deps.notify(platform, message.senderId, result.status === 'locked' ? 'pair_locked' : 'pair_invalid');
      } else if (result.status === 'ok') {
        if (result.replacedSenderId && result.replacedSenderId !== message.senderId) await this.deps.notify(platform, result.replacedSenderId, 'pair_replaced');
        await this.deps.notify(platform, message.senderId, message.isContact === false ? 'pair_ok_add_friend' : 'pair_ok');
      } else return 'unavailable';
      return 'handled';
    }
    if (command.kind === 'usage') {
      if (!this.deps.notify) return 'unavailable';
      await this.deps.notify(platform, message.senderId, 'usage');
      return 'handled';
    }
    if (command.kind === 'sms') {
      if (!this.deps.sms) return 'unavailable';
      await this.deps.sms(platform, message.senderId, command.numbers, command.body, message.platformMessageId);
    } else {
      if (!this.deps.call) return 'unavailable';
      await this.deps.call(platform, message.senderId, command.numbers, message.platformMessageId);
    }
    return 'handled';
  }
}
