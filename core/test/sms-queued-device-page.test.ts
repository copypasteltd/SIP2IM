import type pg from 'pg';
import {expect,it,vi} from 'vitest';
import {SmsQueueRepository,SMS_QUEUED_DEVICE_PAGE} from '../src/sms/queue-repo.js';

const deviceIds = (start: number, count: number) => Array.from({length:count}, (_,i) => 'd'+String(start+i).padStart(3,'0'));
const deviceRows = (ids: string[]) => ids.map(deviceId=>({deviceId}));

it('requests a bounded, ordered inventory and keeps only a continuation key, not the lookahead ID',async()=>{
  let eligible=deviceIds(1,35);
  const query=vi.fn(async(_sql:string,[limit,after]:[number,string?])=>({
    rows:deviceRows(eligible.filter(id=>after===undefined||id>after).slice(0,limit)),
  }));
  const repo=new SmsQueueRepository({query} as unknown as pg.Pool);
  expect(SMS_QUEUED_DEVICE_PAGE).toBe(32);
  const first=await repo.queuedDevices(null);
  expect(first).toEqual({ids:deviceIds(1,32),nextAfter:'d032'});
  // A cursor is an ordering boundary, not a record that must still qualify.
  eligible=eligible.filter(id=>id!=='d032');
  await expect(repo.queuedDevices(first.nextAfter)).resolves.toEqual({ids:['d033','d034','d035'],nextAfter:null});

  expect(query.mock.calls).toEqual([
    [expect.not.stringContaining('d.id > $2'),[33]],
    [expect.stringContaining('AND d.id > $2'),[33,'d032']],
  ]);
  for(const [sql] of query.mock.calls){
    expect(sql).toContain('ORDER BY d.id LIMIT $1');
    expect(sql).not.toContain('OFFSET');
    expect(sql).toContain('d.online AND d.enabled AND NOT d.paused AND d.revoked_at IS NULL');
    expect(sql).toContain('AND EXISTS (');
    expect(sql).toContain("m.device_id=d.id AND m.direction='out' AND t.state='queued' AND s.device_id=d.id AND s.retired_at IS NULL");
  }
});

it('marks an exact-size or empty final page as exhausted',async()=>{
  const ids=deviceIds(1,32);
  const query=vi.fn().mockResolvedValueOnce({rows:deviceRows(ids)}).mockResolvedValueOnce({rows:[]});
  const repo=new SmsQueueRepository({query} as unknown as pg.Pool);
  await expect(repo.queuedDevices(null)).resolves.toEqual({ids,nextAfter:null});
  await expect(repo.queuedDevices('missing')).resolves.toEqual({ids:[],nextAfter:null});
  expect(query).toHaveBeenCalledTimes(2);
});
