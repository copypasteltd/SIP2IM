import type { MessagePlatform } from './message-router.js';

/** Opaque, process-local session identity. It must not be reconstructed from a wire payload. */
declare const sessionBrand: unique symbol;
export type AdapterSession = Readonly<{
  platform: MessagePlatform;
  generation: number;
  [sessionBrand]: true;
}>;

/** Issued only after a trusted verifier establishes the account for this exact session. */
declare const verifiedBrand: unique symbol;
export type VerifiedAdapterIdentity = Readonly<{
  session: AdapterSession;
  verifiedAccountId: string;
  [verifiedBrand]: true;
}>;

/**
 * Boundary for a future trusted, generation-aware identity provider. A hello or
 * account.state payload is not proof of either peer or account authentication.
 * Replacement, disconnect, logout, and account changes must invalidate contexts.
 *
 * This is an interface only: neither lookup nor isCurrent is an atomic fence for
 * asynchronous writes. Durable inbox processing requires a persisted fencing token
 * checked in the same transaction as the effect, including across process restarts.
 */
export interface AdapterIdentityProvider {
  verifiedIdentity(session: AdapterSession): Promise<VerifiedAdapterIdentity | null>;
  isCurrent(identity: VerifiedAdapterIdentity): Promise<boolean>;
}
