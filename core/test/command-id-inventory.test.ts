import { expect, it, vi } from 'vitest';
import { inventoryCommandIds, type CommandInventoryRow } from '../src/db/command-id-inventory.js';

const row = (command_id: string, overrides: Partial<CommandInventoryRow> = {}): CommandInventoryRow => ({
  command_id, call_session_id: null, call_device_id: null, call_id: null,
  sms_task_id: null, sms_device_id: null, registry_command_type: null,
  registry_owner_type: null, registry_owner_id: null, registry_device_id: null, ...overrides,
});

it('returns overlap, unregistered attempts and registry-only evidence across bounded pages', async () => {
  const data = [
    row('', {call_session_id:'empty-call', call_device_id:'d', call_id:'c'}),
    row('a', {call_session_id:'call', call_device_id:'d1', call_id:'c', sms_task_id:'sms', sms_device_id:'d2'}),
    row('b', {sms_task_id:'legacy', sms_device_id:'d'}),
    row('c', {registry_command_type:'type', registry_owner_type:'owner', registry_owner_id:'id', registry_device_id:'d'}),
  ];
  const query = vi.fn(async (sql: string, args: (string | number | null)[]) => {
    expect(sql.trimStart()).toMatch(/^WITH ids AS/);
    expect(sql).toMatch(/UNION[\s\S]*sms_dispatch_attempt[\s\S]*UNION[\s\S]*command_namespace_reservation/);
    expect(sql).toMatch(/LIMIT \$2/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|FOR UPDATE)\b/i);
    return {rows: data.filter(r => args[0] === null || r.command_id > (args[0] as string)).slice(0, args[1] as number)};
  });
  const first = await inventoryCommandIds({query}, {limit:1});
  expect(first.rows).toEqual([data[0]]); expect(first.nextCursor).toBe('');
  const second = await inventoryCommandIds({query}, {limit:2, after:first.nextCursor});
  expect(second.rows).toEqual(data.slice(1,3)); expect(second.nextCursor).toBe('b');
  const last = await inventoryCommandIds({query}, {limit:2, after:second.nextCursor});
  expect(last.rows).toEqual([data[3]]); expect(last.nextCursor).toBeNull();
  expect(query.mock.calls.map(c => c[1])).toEqual([[null,2],['',3],['b',3]]);
  expect(first.limitations.join(' ')).toMatch(/Android in-memory.*evicted/i);
  expect(first.limitations.join(' ')).toMatch(/separate database snapshots/i);
});

it('validates limits and parameterizes hostile cursor values', async () => {
  const query = vi.fn(async (_sql:string, _values:(string | number | null)[]) => ({rows:[]}));
  for (const limit of [0, -1, 1.5, 1001, NaN]) await expect(inventoryCommandIds({query}, {limit})).rejects.toThrow();
  for (const after of ['\0', '\ud800', '\udc00']) await expect(inventoryCommandIds({query}, {after})).rejects.toThrow();
  expect(query).not.toHaveBeenCalled();
  const cursor = "x' OR true --";
  await inventoryCommandIds({query}, {after:cursor});
  expect(query.mock.calls[0]![0]).not.toContain(cursor);
  expect(query.mock.calls[0]![1]).toEqual([cursor,101]);
});
