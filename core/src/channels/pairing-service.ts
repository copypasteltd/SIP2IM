import { createHash, randomInt } from 'node:crypto';
import type { PairingPlatform, Redemption } from './pairing-repo.js';
export interface PairingStore {
  issue(platform: PairingPlatform, hash: Buffer): Promise<number>;
  redeem(platform: PairingPlatform, hash: Buffer, senderId: string, displayName: string | null): Promise<Redemption>;
}
export class PairingService {
  constructor(private readonly store: PairingStore) {}
  async issue(platform: PairingPlatform): Promise<{ code: string; expiresAt: number }> {
    const code = randomInt(100_000_000).toString().padStart(8, '0');
    return { code, expiresAt: await this.store.issue(platform, digest(code)) };
  }
  async redeem(platform: PairingPlatform, code: string, senderId: string, displayName: string | null): Promise<Redemption> {
    if (!/^[0-9]{8}$/.test(code) || !senderId) throw new Error('Invalid pairing input');
    return this.store.redeem(platform, digest(code), senderId, displayName);
  }
}
function digest(code: string): Buffer { return createHash('sha256').update(code, 'utf8').digest(); }
