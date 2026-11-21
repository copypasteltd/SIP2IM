import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

it('ships migration files with unique ordered numeric versions', async () => {
  const files = (await readdir(resolve('migrations'))).filter(name => /^\d{4}_.+\.sql$/.test(name));
  expect(files.length).toBeGreaterThan(0);
  const versions = files.map(name => Number(name.slice(0, 4)));
  expect(new Set(versions).size).toBe(versions.length);
});

it('backfills unexpired historical pairing lockouts', async () => {
  const sql = await readFile(resolve('migrations/0007_pairing_lock.sql'), 'utf8');
  expect(sql).toContain('lag(a.ts, 4)');
  expect(sql).toContain("fifth_previous > ts - interval '10 minutes'");
  expect(sql).toContain("max(ts + interval '30 minutes')");
  expect(sql).toContain("ts + interval '30 minutes' > clock_timestamp()");
  expect(sql).toContain('insert into pairing_lock(platform, sender_id, locked_until)');
});
