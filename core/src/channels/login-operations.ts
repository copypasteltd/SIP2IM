import { AdapterAdmissionRejected, type AdapterAck, type AdapterAdmissionCode, type AdapterLoginCommand, type AdapterManager, type AdapterPlatform } from './adapter-manager.js';
export type LoginOperationStatus = 'idle' | 'pending' | 'unknown';
export type LoginOperationResult =
  | { kind: 'ack'; ack: AdapterAck }
  | { kind: 'rejected'; code: AdapterAdmissionCode }
  | { kind: 'blocked' | 'unavailable' | 'invalid' | 'unknown' };

export function knownLocalRejection(error: unknown): AdapterAdmissionRejected | null {
  return error instanceof AdapterAdmissionRejected ? error : null;
}

/** Process-local model for isolated tests. Production must use the durable gate. */
export class LoginOperations {
  private readonly states = new Map<AdapterPlatform, LoginOperationStatus>();
  constructor(private readonly manager: Pick<AdapterManager, 'send'>) {}

  status(platform: AdapterPlatform): LoginOperationStatus { return this.states.get(platform) ?? 'idle'; }

  async execute(platform: AdapterPlatform, type: AdapterLoginCommand, payload: unknown): Promise<LoginOperationResult> {
    if (this.status(platform) !== 'idle') return { kind: 'blocked' };
    // Set before invoking send, including when send throws synchronously.
    this.states.set(platform, 'pending');
    try {
      const ack = await this.manager.send(platform, type, payload);
      if (ack.ok) {
        this.states.delete(platform);
        return { kind: 'ack', ack };
      }
      this.states.set(platform, 'unknown');
      return { kind: 'unknown' };
    } catch (error) {
      const rejection = knownLocalRejection(error);
      if (rejection) {
        this.states.delete(platform);
        return { kind: 'rejected', code: rejection.code };
      }
      // Compatibility for the isolated legacy transport model.
      if (error instanceof Error && (error.message === 'offline' || error.message === 'invalid command')) {
        this.states.delete(platform);
        return { kind: error.message === 'offline' ? 'unavailable' : 'invalid' };
      }
      this.states.set(platform, 'unknown');
      return { kind: 'unknown' };
    }
  }
}
