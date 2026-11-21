import { describe, expect, it, vi } from 'vitest';
import { MessageRouter, parseInboundCommand, type MessageRouterDependencies } from '../src/channels/message-router.js';

const message = { platformMessageId: '1', senderId: 'alice', senderName: 'Alice', chatType: 'private', forwarded: false, isContact: true, text: '23456789', ts: 123 };
function setup(paired = true) {
  const seen = new Set<string>();
  const deps: MessageRouterDependencies = {
    recordInbound: vi.fn(async (platform, m) => { const key = JSON.stringify([platform, m.platformMessageId]); if (seen.has(key)) return false; seen.add(key); return true; }),
    isPaired: vi.fn(async () => paired),
    pair: vi.fn(async () => ({ status: 'ok' as const, replacedSenderId: 'old' })),
    notify: vi.fn(async () => {}), sms: vi.fn(async () => {}), call: vi.fn(async () => {}),
  };
  return { deps, router: new MessageRouter(deps) };
}

describe('platform inbound router', () => {
  it('validates and ignores group and forwarded messages before persistence', async () => {
    const { deps, router } = setup();
    expect(await router.route('qq', { ...message, senderId: '' })).toBe('invalid');
    expect(await router.route('qq', { ...message, forwarded: 'false' })).toBe('invalid');
    expect(await router.route('unknown', message)).toBe('invalid');
    expect(await router.route('qq', { ...message, chatType: 'group' })).toBe('ignored');
    expect(await router.route('qq', { ...message, forwarded: true })).toBe('ignored');
    expect(deps.recordInbound).not.toHaveBeenCalled();
  });
  it('persists before authorization, deduplicates by platform and suppresses repeated side effects', async () => {
    const { deps, router } = setup();
    expect(await router.route('qq', message)).toBe('handled');
    expect(await router.route('qq', message)).toBe('duplicate');
    expect(await router.route('telegram', message)).toBe('handled');
    expect(deps.call).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.recordInbound).mock.invocationCallOrder[0]!).toBeLessThan(vi.mocked(deps.isPaired).mock.invocationCallOrder[0]!);
  });
  it('ignores unpaired commands and permits only whole pairing code', async () => {
    const { deps, router } = setup(false);
    expect(await router.route('qq', { ...message, text: 'sms 23456789 hi' })).toBe('ignored');
    expect(deps.sms).not.toHaveBeenCalled(); expect(deps.notify).not.toHaveBeenCalled();
    expect(await router.route('qq', { ...message, platformMessageId:'2', text:' 绑定 12345678 ', isContact:false })).toBe('handled');
    expect(deps.pair).toHaveBeenCalledWith('qq', 'alice', '12345678', 'Alice');
    expect(deps.notify).toHaveBeenNthCalledWith(1, 'qq', 'old', 'pair_replaced');
    expect(deps.notify).toHaveBeenNthCalledWith(2, 'qq', 'alice', 'pair_ok_add_friend');
  });
  it.each(['invalid', 'locked'] as const)('notifies pairing %s result', async status => {
    const { deps, router } = setup(false); deps.pair = vi.fn(async () => ({ status }));
    expect(await router.route('qq', { ...message, text:'12345678' })).toBe('handled');
    expect(deps.notify).toHaveBeenCalledWith('qq', 'alice', status === 'invalid' ? 'pair_invalid' : 'pair_locked');
  });
  it('fails closed for missing handlers and propagates storage failures', async () => {
    const deps: MessageRouterDependencies = { recordInbound: async () => true, isPaired: async () => true };
    expect(await new MessageRouter(deps).route('qq', message)).toBe('unavailable');
    deps.recordInbound = async () => { throw new Error('offline'); };
    await expect(new MessageRouter(deps).route('qq', message)).rejects.toThrow('offline');
  });
  it('parses command precedence, strict syntax and number normalization', () => {
    expect(parseInboundCommand('12345678', false)).toEqual({kind:'pair',code:'12345678'});
    expect(parseInboundCommand('23456789', true)).toEqual({kind:'call',numbers:{from:null,to:'+85223456789'}});
    expect(parseInboundCommand('绑定12345678', true)).toEqual({kind:'pair',code:'12345678'});
    expect(parseInboundCommand('sms 23456789 hello\nworld', true)).toEqual({kind:'sms',numbers:{from:null,to:'+85223456789'},body:'hello\nworld'});
    expect(parseInboundCommand('23456789 ／ 91234567', true)).toEqual({kind:'call',numbers:{from:'+85223456789',to:'+85291234567'}});
    expect(parseInboundCommand('Sms 23456789 hi', true)).toEqual({kind:'usage'});
    expect(parseInboundCommand('绑定 12345678 extra', false)).toEqual({kind:'ignore'});
    expect(parseInboundCommand('sms 2345 6789 hi', true)).toEqual({kind:'sms',numbers:{from:null,to:'2345'},body:'6789 hi'});
  });
});
