import { readFile } from 'node:fs/promises';
import type pg from 'pg';
import { expect, it, vi } from 'vitest';
import { CommandNamespaceRepository, type CommandReservation } from '../src/db/command-namespace-repo.js';

const base: CommandReservation = {commandId:'cmd_1', commandType:'sms.send', ownerType:'sms_task', ownerId:'task_1', deviceId:'dev_1'};
function fixture() {
  const rows = new Map<string, string[]>();
  const query = vi.fn(async (sql: string, args: string[]) => {
    if (sql.startsWith('INSERT INTO command_namespace_reservation')) {
      if (rows.has(args[0]!)) return {rowCount:0, rows:[]};
      rows.set(args[0]!, [...args]); return {rowCount:1, rows:[{command_id:args[0]}]};
    }
    if (sql.startsWith('SELECT command_id FROM command_namespace_reservation')) {
      const found = rows.get(args[0]!);
      const match = !!found && found.every((value, i) => value === args[i]);
      return {rowCount:match ? 1 : 0, rows:match ? [{command_id:args[0]}] : []};
    }
    throw new Error('Unexpected SQL: '+sql);
  });
  return {repo:new CommandNamespaceRepository({query} as unknown as pg.PoolClient), query, rows};
}

it('defines an empty, additive, exact shared namespace', async () => {
  const sql = await readFile('migrations/0020_command_namespace_reservation.sql','utf8');
  expect(sql).toContain('command_id text COLLATE \"C\" PRIMARY KEY'.replaceAll('\\',''));
  expect(sql).toMatch(/command_type text COLLATE \"C\" NOT NULL/.source.replaceAll('\\',''));
  expect(sql).not.toMatch(/INSERT\s+INTO|ALTER\s+TABLE|UPDATE\s+/i);
});

it('reserves an ID once across command kinds and owners', async () => {
  const {repo, query, rows} = fixture();
  expect(await repo.reserve(base)).toBe(true);
  for (const change of [{}, {commandType:'call.start', ownerType:'call_session', ownerId:'call_1'}, {deviceId:'dev_2'}]) {
    expect(await repo.reserve({...base, ...change})).toBe(false);
  }
  expect(rows.size).toBe(1);
  expect(query.mock.calls[0]![0]).toContain('ON CONFLICT (command_id) DO NOTHING');
});

it('matches only the full exact type and owner tuple', async () => {
  const {repo} = fixture(); await repo.reserve(base);
  expect(await repo.matches(base)).toBe(true);
  for (const change of [{commandId:'CMD_1'}, {commandType:'SMS.send'}, {ownerType:'call_session'}, {ownerId:'task_2'}, {deviceId:'dev_2'}]) {
    expect(await repo.matches({...base,...change})).toBe(false);
  }
});

it('does not establish absence of IDs in legacy SMS, call, or transport allocators', async () => {
  const legacySms = new Set(['cmd_sms']);
  const legacyCall = new Set(['cmd_call']);
  const unpersistedTransport = new Set(['cmd_hello', 'cmd_ack']);
  const {repo} = fixture();
  for (const commandId of [...legacySms, ...legacyCall, ...unpersistedTransport]) {
    expect(await repo.reserve({...base, commandId})).toBe(true);
  }
  // These successes demonstrate the integration blocker, not safe ownership.
});

it('rejects invalid fields and propagates database uncertainty', async () => {
  const {repo, query} = fixture();
  await expect(repo.reserve({...base, ownerId:''})).rejects.toThrow('nonempty');
  expect(query).not.toHaveBeenCalled();
  query.mockRejectedValueOnce(new Error('connection lost'));
  await expect(repo.reserve(base)).rejects.toThrow('connection lost');
});
