import {it,expect,vi} from 'vitest';
import type pg from 'pg';
import {reconcileCalls} from '../src/calls/reconcile.js';

it('atomically records uncertain sessions and disables pending commands on restart', async()=>{
 const queries:{sql:string;args:unknown[]}[]=[];
 const client={query:vi.fn(async(sql:string,args:unknown[]=[])=>{
  queries.push({sql,args});
  if(sql.startsWith('SELECT id,state')) return {rows:[{id:'a',state:'bridged'},{id:'b',state:'unknown'},{id:'c',state:'rejecting'}],rowCount:3};
  return {rows:[],rowCount:1,command:sql};
 }),release:vi.fn()};
 const count=await reconcileCalls({connect:async()=>client} as unknown as pg.Pool);
 expect(count).toBe(2);
 expect(queries.filter(q=>q.sql.startsWith('UPDATE call_reject_intent')).map(q=>q.args)).toEqual([['a'],['b'],['c']]);
 expect(queries.filter(q=>q.sql.startsWith('UPDATE call_session')).map(q=>q.args.slice(0,4))).toEqual([['a','bridged','unknown','unknown'],['c','rejecting','unknown','unknown']]);
 expect(queries.filter(q=>q.args.includes('state:unknown'))).toHaveLength(2);
 expect(queries.at(-1)?.sql).toBe('COMMIT');
 expect(client.release).toHaveBeenCalled();
});

it('ends a browser reservation only when the restart query finds positive evidence that it was never armed', async () => {
 const queries: { sql: string; args: unknown[] }[] = [];
 const client = { query: vi.fn(async (sql: string, args: unknown[] = []) => {
  queries.push({ sql, args });
  if (sql.startsWith('SELECT id,state')) {
   expect(sql).toContain("kind='web_out' AND state='awaiting_browser'");
   expect(sql).toContain('NOT EXISTS (SELECT 1 FROM call_outbound_attempt');
   expect(sql).toContain("l.type='cellular' AND l.state='created'");
   return { rows: [{ id: 'unarmed', state: 'awaiting_browser', unarmed: true },
    { id: 'armed', state: 'cell_dialing', unarmed: false }], rowCount: 2 };
  }
  return { rows: [], rowCount: 1, command: sql };
 }), release: vi.fn() };
 expect(await reconcileCalls({ connect: async () => client } as unknown as pg.Pool)).toBe(2);
 expect(queries.filter(q => q.sql.startsWith('UPDATE call_leg')).map(q => q.args)).toEqual([['unarmed']]);
 expect(queries.filter(q => q.sql.startsWith('UPDATE call_session')).map(q => q.args.slice(0, 4))).toEqual([
  ['unarmed', 'awaiting_browser', 'ended', null], ['armed', 'cell_dialing', 'unknown', 'unknown'],
 ]);
 expect(queries.at(-1)?.sql).toBe('COMMIT');
});

it('rolls back recovery if recording the state event fails', async()=>{
 const queries:string[]=[];
 const client={query:vi.fn(async(sql:string)=>{queries.push(sql);if(sql.startsWith('SELECT id,state'))return {rows:[{id:'a',state:'rejecting'}],rowCount:1};if(sql.startsWith('INSERT INTO call_event'))throw new Error('database failure');return {rows:[],rowCount:1,command:sql};}),release:vi.fn()};
 await expect(reconcileCalls({connect:async()=>client} as unknown as pg.Pool)).rejects.toThrow('database failure');
 expect(queries.at(-1)).toBe('ROLLBACK');
 expect(client.release).toHaveBeenCalled();
});
