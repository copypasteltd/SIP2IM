import { settingsPatchSchema, type Settings, type SettingsPatch } from './schema.js';

export interface SettingsStore {
  get(): Promise<Settings>;
  update(patch: SettingsPatch, expected?: SettingsPatch): Promise<{ before: Settings; after: Settings }>;
}
export interface SettingsEffects {
  publish(settings: Settings): Promise<void> | void;
  updateDevices?(config: { heartbeatSec: number; locale: string }): Promise<void> | void;
}

/** Serializes local reads and mutations, and orders best-effort effects. */
export class SettingsService {
  private tail: Promise<void> = Promise.resolve();
  private effectsTail: Promise<void> = Promise.resolve();
  constructor(
    private readonly store: SettingsStore,
    private readonly effects: SettingsEffects,
    // Reporter must return promptly; it receives no error or settings data.
    private readonly reportEffectFailure?: (effect: 'publish' | 'updateDevices') => void,
  ) {}

  private reportFailure(effect: 'publish' | 'updateDevices'): void {
    try {
      void Promise.resolve(this.reportEffectFailure?.(effect)).catch(() => undefined);
    } catch {
      // Reporting is best effort and must not interfere with subsequent effects.
    }
  }
  /** Call after HTTP and device transports have stopped admitting work. */
  async drain(): Promise<void> {
    await this.tail;
    await this.effectsTail;
  }

  get(): Promise<Settings> {
    const operation = this.tail.then(async () => ({ ...await this.store.get() }));
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
  update(input: unknown, expectedInput?: unknown): Promise<Settings> {
    const patch = settingsPatchSchema.parse(input);
    const expected = expectedInput === undefined ? undefined : settingsPatchSchema.parse(expectedInput);
    if (expected && (Object.keys(patch).length !== Object.keys(expected).length || Object.keys(patch).some(key => !Object.prototype.hasOwnProperty.call(expected, key) || patch[key as keyof Settings] === undefined || expected[key as keyof Settings] === undefined))) throw new Error('BAD_REQUEST');
    const operation = this.tail.then(async () => {
      // The store merges and validates against the state read under its lock.
      // Fresh reads do not prove that an uncertain write has quiesced.
      const { before, after } = await this.store.update(patch, expected);
      this.effectsTail = this.effectsTail.then(async () => {
        try {
          await this.effects.publish({ ...after });
        } catch {
          this.reportFailure('publish');
        }
        if (this.effects.updateDevices && (before.heartbeatSec !== after.heartbeatSec || before.botLocale !== after.botLocale)) {
          try {
            await this.effects.updateDevices({ heartbeatSec: after.heartbeatSec, locale: after.botLocale });
          } catch {
            this.reportFailure('updateDevices');
          }
        }
      }).catch(() => undefined);
      return { ...after };
    });
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }
}
