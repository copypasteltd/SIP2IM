import { describe, expect, it } from 'vitest';
import type { AdapterIdentityProvider, AdapterSession, VerifiedAdapterIdentity } from '../src/channels/adapter-identity.js';

// A contract fake only. Casting here simulates a future trusted issuer; it is not verification.
class FakeIdentityProvider implements AdapterIdentityProvider {
  private sessions = new Map<string, AdapterSession>();
  private identities = new Map<AdapterSession, VerifiedAdapterIdentity>();
  attach(platform: 'qq' | 'telegram', generation: number): AdapterSession {
    const session = Object.freeze({ platform, generation }) as AdapterSession;
    this.sessions.set(platform, session);
    return session;
  }
  verify(session: AdapterSession, account: string): void {
    if (this.sessions.get(session.platform) !== session || !account) throw new Error('invalid session');
    this.identities.set(session, Object.freeze({ session, verifiedAccountId: account }) as VerifiedAdapterIdentity);
  }
  invalidate(session: AdapterSession): void {
    if (this.sessions.get(session.platform) === session) this.sessions.delete(session.platform);
    this.identities.delete(session);
  }
  async verifiedIdentity(session: AdapterSession): Promise<VerifiedAdapterIdentity | null> {
    return this.sessions.get(session.platform) === session ? this.identities.get(session) ?? null : null;
  }
  async isCurrent(identity: VerifiedAdapterIdentity): Promise<boolean> {
    return (await this.verifiedIdentity(identity.session)) === identity;
  }
}

describe('adapter identity provider contract (fake)', () => {
  it('requires verification and invalidates a replaced generation', async () => {
    const fake = new FakeIdentityProvider();
    const old = fake.attach('qq', 1);
    expect(await fake.verifiedIdentity(old)).toBeNull();
    fake.verify(old, 'account-a');
    const identity = (await fake.verifiedIdentity(old))!;
    expect(identity.verifiedAccountId).toBe('account-a');
    const next = fake.attach('qq', 2);
    expect(await fake.isCurrent(identity)).toBe(false);
    expect(await fake.verifiedIdentity(next)).toBeNull();
    expect(() => fake.verify(old, 'account-a')).toThrow();
    fake.verify(next, 'account-b');
    expect((await fake.verifiedIdentity(next))?.verifiedAccountId).toBe('account-b');
  });
  it('isolates platforms and revokes contexts on disconnect or account change', async () => {
    const fake = new FakeIdentityProvider();
    const qq = fake.attach('qq', 1), telegram = fake.attach('telegram', 1);
    fake.verify(qq, 'a'); fake.verify(telegram, 'b');
    const original = (await fake.verifiedIdentity(qq))!;
    const other = (await fake.verifiedIdentity(telegram))!;
    fake.verify(qq, 'c');
    expect(await fake.isCurrent(original)).toBe(false);
    fake.invalidate(qq);
    expect(await fake.verifiedIdentity(qq)).toBeNull();
    expect(await fake.isCurrent(other)).toBe(true);
    fake.invalidate(telegram);
    expect(await fake.isCurrent(other)).toBe(false);
  });
});
