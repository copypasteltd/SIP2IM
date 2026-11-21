import { expect, it, vi } from 'vitest';
import type { Pool } from 'pg';
import { parseInventoryOptions, runCommandInventory } from '../src/cli/command-id-inventory.js';

function fake(failAt = '') {
  const rows = ['', 'a', 'b'].map(command_id => ({ command_id, call_session_id: null, call_device_id: null, call_id: null, sms_task_id: null, sms_device_id: null, registry_command_type: null, registry_owner_type: null, registry_owner_id: null, registry_device_id: null }));
  const calls: string[] = [];
  const query = vi.fn(async (sql: string, values?: (string | number | null)[]) => {
    const kind = sql.startsWith('WITH') ? 'SELECT' : sql.split(' ')[0]!; calls.push(kind);
    if (kind === failAt) throw Error('failure');
    if (kind === 'SELECT') return { rows: rows.filter(r => values![0] === null || r.command_id > (values![0] as string)).slice(0, values![1] as number) };
    return { command: kind, rows: [] };
  });
  const release = vi.fn(); const end = vi.fn(async () => {});
  const connect = vi.fn(async () => ({ query, release }));
  return { pool: { connect, end } as unknown as Pool, calls, query, release, end, rows };
}
const collect = () => { const records: any[] = []; return { records, write: async (r: unknown) => { records.push(r); } }; };

it('streams all pages from one read-only snapshot and commits before completion', async () => {
  const f = fake(), out = collect();
  expect(await runCommandInventory(f.pool, {pageSize:1,maxRows:null}, out.write)).toBe(true);
  expect(f.calls).toEqual(['BEGIN','SELECT','SELECT','SELECT','COMMIT']);
  expect(f.query.mock.calls[0]![0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  expect(f.query.mock.calls.filter(c => c[0].startsWith('WITH')).map(c => c[1]![0])).toEqual([null,'','a']);
  expect(out.records.filter(x=>x.type==='row').map(x=>x.row)).toEqual(f.rows);
  expect(out.records.at(-1)).toMatchObject({type:'status',complete:true,rows:3});
  expect(f.release).toHaveBeenCalledWith(false); expect(f.end).toHaveBeenCalledOnce();
});
it('marks a row cap partial with the exact boundary, including empty string', async () => {
  const f=fake(), out=collect();
  expect(await runCommandInventory(f.pool,{pageSize:1,maxRows:1},out.write)).toBe(false);
  expect(out.records.at(-1)).toMatchObject({complete:false,reason:'max_rows',continuation:'',rows:1});
});
it('rolls back and destroys the client on query or output failure', async () => {
  for (const mode of ['SELECT','output']) {
    const f=fake(mode), out=collect();
    const write=async (r:any) => { if(mode==='output' && r.type==='row') throw Error('broken output'); await out.write(r); };
    expect(await runCommandInventory(f.pool,{pageSize:1,maxRows:null},write)).toBe(false);
    expect(f.calls.at(-1)).toBe('ROLLBACK'); expect(f.release).toHaveBeenCalledWith(true);
    expect(out.records.at(-1)).toMatchObject({complete:false,reason:'error'});
  }
});
it('does not report completion when commit fails or output status fails', async () => {
  const f=fake('COMMIT'), out=collect();
  expect(await runCommandInventory(f.pool,{pageSize:3,maxRows:null},out.write)).toBe(false);
  expect(out.records.at(-1)).toMatchObject({complete:false,reason:'error'});
  const g=fake(); expect(await runCommandInventory(g.pool,{pageSize:3,maxRows:null},async (r:any)=>{if(r.type==='status') throw Error('closed');})).toBe(false);
});

it('treats exact EOF at the cap as complete', async () => {
  const f=fake(), out=collect();
  expect(await runCommandInventory(f.pool,{pageSize:3,maxRows:3},out.write)).toBe(true);
  expect(out.records.at(-1)).toMatchObject({complete:true,rows:3,continuation:null});
});
it('reports rollback and cleanup failures without exposing their messages', async () => {
  const f=fake('SELECT'), out=collect();
  f.query.mockImplementation(async (sql: string) => {
    if(sql.startsWith('BEGIN')) return {command:'BEGIN',rows:[]};
    throw Error('secret detail');
  });
  f.release.mockImplementation(() => {throw Error('secret release');});
  f.end.mockImplementation(async () => {throw Error('secret end');});
  expect(await runCommandInventory(f.pool,{pageSize:1,maxRows:null},out.write)).toBe(false);
  expect(out.records.at(-1)).toMatchObject({complete:false,errors:['query','rollback','release','pool_end']});
  expect(JSON.stringify(out.records)).not.toContain('secret');
});


it('emits successful status only after release and pool closure', async () => {
  const f=fake(), out=collect();
  const write=async (r:any) => { if(r.type==='status') { expect(f.release).toHaveBeenCalledOnce(); expect(f.end).toHaveBeenCalledOnce(); } await out.write(r); };
  expect(await runCommandInventory(f.pool,{pageSize:2,maxRows:null},write)).toBe(true);
});

it('validates options before connecting', () => {
  expect(parseInventoryOptions([])).toEqual({pageSize:100,maxRows:null});
  expect(parseInventoryOptions(['--page-size','2','--max-rows','3'])).toEqual({pageSize:2,maxRows:3});
  for (const args of [['--page-size','0'],['--page-size','1001'],['--max-rows','2x'],['--max-rows'],['--nope','1'],['--page-size','1','--page-size','2']]) expect(() => parseInventoryOptions(args)).toThrow();
});
