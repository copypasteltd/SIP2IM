import { createHash } from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type pg from 'pg';
import { PairingService } from '../src/channels/pairing-service.js';
import { PairingRepository } from '../src/channels/pairing-repo.js';

describe('pairing offline', () => {
  it('issues an eight digit code and passes only its SHA-256 digest to storage', async () => {
    const issue = vi.fn(async (_platform: 'qq' | 'telegram', _hash: Buffer) => 123456);
    const redeem = vi.fn(async (_platform: 'qq' | 'telegram', _hash: Buffer, _sender: string, _name: string | null) => ({ status: 'invalid' as const }));
    const service = new PairingService({ issue, redeem });
    const result = await service.issue('qq');
    expect(result.code).toMatch(/^[0-9]{8}$/);
    expect(result.expiresAt).toBe(123456);
    expect(issue.mock.calls[0]![1]).toEqual(createHash('sha256').update(result.code).digest());
    await service.redeem('telegram', result.code, 'sender', null);
    expect(redeem.mock.calls[0]![1]).toEqual(createHash('sha256').update(result.code).digest());
  });
  it('uses a platform row lock and commits the replacement with code consumption', async () => {
    const old = { id:'old',platform:'qq',platformUserId:'old-user',displayName:null,pairedAt:10 };
    const current = { id:'new',platform:'qq',platformUserId:'new-user',displayName:'New',pairedAt:20 };
    const calls: string[] = [];
    const query = vi.fn(async (sql: string) => {
      calls.push(sql);
      if (sql.startsWith('SELECT platform')) return {rowCount:1,rows:[{}]};
      if (sql.startsWith('SELECT count')) return {rows:[{count:'0'}]};
      if (sql.startsWith('UPDATE pairing_code')) return {rowCount:1,rows:[{id:'code'}]};
      if (sql.startsWith('UPDATE paired_user')) return {rows:[old]};
      if (sql.startsWith('INSERT INTO paired_user')) return {rows:[current]};
      return {rows:[],rowCount:0,command:sql};
    });
    const release=vi.fn();
    const repo=new PairingRepository({connect:async()=>({query,release})} as unknown as pg.Pool);
    expect(await repo.redeem('qq', Buffer.alloc(32), 'new-user', 'New')).toEqual({status:'paired',pairedUser:current,replacedUser:old});
    expect(calls[0]).toBe('BEGIN');
    expect(calls[1]).toContain('FOR UPDATE');
    expect(calls.find(s=>s.startsWith('UPDATE pairing_code'))).toContain('expires_at>clock_timestamp()');
    expect(calls.at(-1)).toBe('COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });
  it('invalidates earlier codes and stores a five-minute digest in one transaction', async () => {
    const query=vi.fn(async (sql:string)=>sql.startsWith('SELECT platform')?{rowCount:1,rows:[{}]}:sql.startsWith('INSERT INTO pairing_code')?{rows:[{expiresAt:'300000'}]}:{rows:[],command:sql});
    const repo=new PairingRepository({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
    expect(await repo.issue('qq',Buffer.alloc(32))).toBe(300000);
    const sql=query.mock.calls.map(([s])=>s);
    expect(sql.find(s=>s.startsWith('UPDATE pairing_code'))).toContain('used_at IS NULL');
    expect(sql.find(s=>s.startsWith('INSERT INTO pairing_code'))).toContain("interval '5 minutes'");
    expect(sql.at(-1)).toBe('COMMIT');
  });
  it('records an invalid attempt without replacing an identity', async () => {
    const query=vi.fn(async (sql:string)=>sql.startsWith('SELECT platform')?{rowCount:1,rows:[{}]}:sql.startsWith('SELECT count')?{rows:[{count:'0'}]}:sql.startsWith('UPDATE pairing_code')?{rowCount:0,rows:[]}:{rows:[],command:sql});
    const repo=new PairingRepository({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
    expect(await repo.redeem('qq',Buffer.alloc(32),'sender',null)).toEqual({status:'invalid'});
    expect(query.mock.calls.some(([s])=>s.startsWith('INSERT INTO pairing_attempt'))).toBe(true);
    expect(query.mock.calls.some(([s])=>s.startsWith('UPDATE paired_user'))).toBe(false);
  });
  it('locks after five failures without consuming a code', async () => {
    const query=vi.fn(async (sql:string)=>sql.startsWith('SELECT platform')?{rowCount:1,rows:[{}]}:sql.startsWith('SELECT 1 FROM pairing_lock')?{rowCount:1,rows:[{}]}:{rows:[],command:sql});
    const repo=new PairingRepository({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
    expect(await repo.redeem('telegram',Buffer.alloc(32),'sender',null)).toEqual({status:'locked'});
    expect(query.mock.calls.some(([sql])=>sql.startsWith('UPDATE pairing_code'))).toBe(false);
  });
  it('sets a durable 30-minute lock on the fifth failure using the actual attempt time', async () => {
    const query=vi.fn(async (sql:string)=>sql.startsWith('SELECT platform')?{rowCount:1,rows:[{}]}:sql.startsWith('SELECT 1 FROM pairing_lock')?{rowCount:0,rows:[]}:sql.startsWith('UPDATE pairing_code')?{rowCount:0,rows:[]}:sql.startsWith('SELECT count')?{rows:[{count:'5'}]}:{rows:[],command:sql});
    const repo=new PairingRepository({connect:async()=>({query,release:vi.fn()})} as unknown as pg.Pool);
    expect(await repo.redeem('qq',Buffer.alloc(32),'sender',null)).toEqual({status:'invalid'});
    const sql=query.mock.calls.map(([s])=>s);
    expect(sql.find(s=>s.startsWith('INSERT INTO pairing_attempt'))).toContain('clock_timestamp()');
    expect(sql.find(s=>s.startsWith('INSERT INTO pairing_lock'))).toContain("interval '30 minutes'");
    expect(sql.at(-1)).toBe('COMMIT');
  });
  it('rolls back code consumption if inserting the identity fails', async () => {
    const query=vi.fn(async (sql:string)=>{if(sql.startsWith('SELECT platform')) return {rowCount:1,rows:[{}]}; if(sql.startsWith('SELECT count')) return {rows:[{count:'0'}]}; if(sql.startsWith('UPDATE pairing_code')) return {rowCount:1,rows:[{}]}; if(sql.startsWith('INSERT INTO paired_user')) throw Error('insert failed'); return {rows:[],command:sql};});
    const release=vi.fn(); const repo=new PairingRepository({connect:async()=>({query,release})} as unknown as pg.Pool);
    await expect(repo.redeem('qq',Buffer.alloc(32),'sender',null)).rejects.toThrow('insert failed');
    expect(query.mock.calls.at(-1)![0]).toBe('ROLLBACK'); expect(release).toHaveBeenCalledOnce();
  });
});
