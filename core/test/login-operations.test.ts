import { describe, expect, it, vi } from 'vitest';
import { LoginOperations } from '../src/channels/login-operations.js';
import type { AdapterManager } from '../src/channels/adapter-manager.js';

const ack = (ok: boolean, error: string | null = null) => ({ refId: 'x', ok, error });

describe('login operations', () => {
  it('locks before dispatch completes and isolates platforms', async () => {
    let finish!: (value: ReturnType<typeof ack>) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; })).mockResolvedValue(ack(true));
    const operations = new LoginOperations({ send } as Pick<AdapterManager, 'send'>);
    const first = operations.execute('qq', 'account.login', {});
    expect(operations.status('qq')).toBe('pending');
    expect(await operations.execute('qq', 'account.logout', {})).toEqual({ kind: 'blocked' });
    expect((await operations.execute('telegram', 'account.login', {})).kind).toBe('ack');
    finish(ack(true));
    expect((await first).kind).toBe('ack');
    expect(operations.status('qq')).toBe('idle');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each(['timeout; outcome unknown', 'disconnected; outcome unknown', 'send failed; outcome unknown'])('keeps %s locked', async message => {
    const send = vi.fn().mockRejectedValue(new Error(message));
    const operations = new LoginOperations({ send } as Pick<AdapterManager, 'send'>);
    expect(await operations.execute('qq', 'account.login.submit', { step: 'code', value: 'secret' })).toEqual({ kind: 'unknown' });
    expect(operations.status('qq')).toBe('unknown');
    expect(await operations.execute('qq', 'account.login', {})).toEqual({ kind: 'blocked' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each(['TIMEOUT_UNKNOWN', 'INTERNAL', 'unexpected'])('locks on ambiguous negative ack %s', async error => {
    const operations = new LoginOperations({ send: vi.fn().mockResolvedValue(ack(false, error)) } as Pick<AdapterManager, 'send'>);
    expect(await operations.execute('qq', 'account.login', {})).toEqual({ kind: 'unknown' });
    expect(operations.status('qq')).toBe('unknown');
  });

  it.each(['BAD_MESSAGE', 'CAPABILITY_UNSUPPORTED', 'CHANNEL_UNAVAILABLE'])('keeps rejection %s unknown without a protocol guarantee', async error => {
    const operations = new LoginOperations({ send: vi.fn().mockResolvedValue(ack(false, error)) } as Pick<AdapterManager, 'send'>);
    expect(await operations.execute('qq', 'account.login', {})).toEqual({ kind: 'unknown' });
    expect(operations.status('qq')).toBe('unknown');
  });

  it.each([['offline', 'unavailable'], ['invalid command', 'invalid']] as const)('releases on pre-dispatch %s', async (message, kind) => {
    const operations = new LoginOperations({ send: vi.fn().mockRejectedValue(new Error(message)) } as Pick<AdapterManager, 'send'>);
    expect(await operations.execute('qq', 'account.login', {})).toEqual({ kind });
    expect(operations.status('qq')).toBe('idle');
  });
});
