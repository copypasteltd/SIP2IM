import type { Readable, Writable } from 'node:stream';

export type AccountState = 'logged_out' | 'login_pending' | 'logged_in' | 'offline' | 'banned' | 'error';
export type CallState = 'dialing' | 'ringing' | 'connected' | 'ended' | 'failed';
export interface PlatformMessage {
  platformMessageId: string; senderId: string; senderName: string | null;
  chatType: 'private' | 'group' | 'channel'; forwarded: boolean;
  isContact: boolean | null; text: string; ts: number;
}
export interface QqBackend {
  login(): Promise<void>; logout(): Promise<void>;
  onState(callback: (state: AccountState) => void): void;
  onMessage(callback: (message: PlatformMessage) => void): void;
  sendMessage(userId: string, text: string): Promise<void>;
  dial(userId: string): Promise<string>; hangup(callId: string): Promise<void>;
  onCallState(callback: (callId: string, state: CallState) => void): void;
  audioIn(): Readable; audioOut(): Writable;
}
export const unsupportedCapabilities = Object.freeze({
  login: false, sendMessage: false, receiveMessage: false, dial: false,
  receiveAudio: false, sendAudio: false, maxConcurrentCalls: 0,
});
