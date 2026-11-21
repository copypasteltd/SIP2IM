import type pg from 'pg';
import { transaction } from '../db/pool.js';
import { settingsPatchSchema, settingsSchema, type Settings, type SettingsPatch } from './schema.js';

const snake = (key: string): string => key.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = (key: string): string => key.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
// Reserved for cooperative Core settings writers; distinct from migration and ownership keys.
export const SETTINGS_LOCK_KEY = [198247303, 1] as const;
const parseRows = (rows: { key: string; value: unknown }[]): Settings =>
  settingsSchema.parse(Object.fromEntries(rows.map(({ key, value }) => [camel(key), value])));

export class SettingsConflict extends Error {
  constructor() { super('SETTINGS_CONFLICT'); this.name = 'SettingsConflict'; }
}

export class SettingsRepository {
  constructor(private readonly pool: pg.Pool) {}
  async get(): Promise<Settings> {
    const result = await this.pool.query('SELECT key,value FROM setting');
    return parseRows(result.rows);
  }
  async update(input: SettingsPatch, expectedInput?: SettingsPatch): Promise<{ before: Settings; after: Settings }> {
    const patch = settingsPatchSchema.parse(input);
    const expected = expectedInput === undefined ? undefined : settingsPatchSchema.parse(expectedInput);
    if (expected && (Object.keys(patch).length !== Object.keys(expected).length || Object.keys(patch).some(key => !Object.prototype.hasOwnProperty.call(expected, key) || patch[key as keyof Settings] === undefined || expected[key as keyof Settings] === undefined))) throw new Error('BAD_REQUEST');
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock($1::int, $2::int)', [...SETTINGS_LOCK_KEY]);
      const before = parseRows((await client.query('SELECT key,value FROM setting')).rows);
      if (expected && (Object.keys(expected) as (keyof Settings)[]).some(key => before[key] !== expected[key])) throw new SettingsConflict();
      const merged = settingsSchema.parse({ ...before, ...patch });
      if (merged.offlineAfterSec <= merged.heartbeatSec) throw new Error('BAD_REQUEST');
      await client.query(
        'INSERT INTO setting (key,value,updated_at) SELECT key,value,now() FROM jsonb_each($1::jsonb) WHERE true ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value,updated_at=now()',
        [JSON.stringify(Object.fromEntries(Object.entries(patch).map(([key, value]) => [snake(key), value])))],
      );
      const after = parseRows((await client.query('SELECT key,value FROM setting')).rows);
      if (after.offlineAfterSec <= after.heartbeatSec) throw new Error('BAD_REQUEST');
      return { before, after };
    });
  }
}
