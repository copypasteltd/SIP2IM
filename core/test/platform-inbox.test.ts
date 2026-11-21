import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { PlatformInboxRepository, type InboxLease } from '../src/channels/inbox-repo.js';
import type { InboundMessage } from '../src/channels/message-router.js';
const identity = {version:1 as const,accountId:'account',peer:{type:'user' as const,id:'sender'},namespace:'server' as const,messageId:'m1'};
const context = {platform:'qq' as const,verifiedAccountId:'account'};
const message: InboundMessage = {identity,platformMessageId:'m1',senderId:'sender',senderName:null,chatType:'private',forwarded:false,isContact:null,text:'hello',ts:1000};
const lease: InboxLease = {platform:'qq',identity,token:'00000000-0000-4000-8000-000000000001',message};
type Reply = {rowCount:number;rows:unknown[]};
function fixture(replies:Reply[]) {
 const release=vi.fn();
 const query=vi.fn(async (sql:string,_args?:unknown[])=>{
  if (['BEGIN','COMMIT','ROLLBACK'].includes(sql)) return {rowCount:null,rows:[],command:sql};
  const next=replies.shift(); if(!next) throw new Error('unexpected query'); return next;
 });
 const client={query,release};
 const connect=vi.fn(async()=>client);
 return {repo:new PlatformInboxRepository({connect,query} as unknown as pg.Pool),query,connect};
}
describe('scoped platform inbox',()=>{
 it('rejects missing, inconsistent or unverified identity before any database operation',async()=>{
  const f=fixture([]);
  await expect(f.repo.receive(context,{...message,identity:undefined})).rejects.toThrow();
  await expect(f.repo.receive({...context,verifiedAccountId:'other'},message)).rejects.toThrow();
  await expect(f.repo.receive(context,{...message,platformMessageId:'other'})).rejects.toThrow();
  await expect(f.repo.receive(context,{...message,forwarded:true})).rejects.toThrow();
  await expect(f.repo.receive(context,{...message,identity:{...identity,peer:{type:'group',id:'sender'}}})).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
 });
 it('uses all scoped identity components as separate parameters',async()=>{
  const f=fixture([{rowCount:0,rows:[]},{rowCount:1,rows:[{}]}]);
  expect(await f.repo.receive(context,message)).toBe('inserted');
  expect(f.query.mock.calls[2]![1]).toEqual(['qq','account','user','sender','server','m1',JSON.stringify(message)]);
  expect(f.query.mock.calls.at(-1)![0]).toBe('COMMIT');
 });
 it.each([[true,'duplicate'],[false,'collision']] as const)('classifies existing scoped payload equality %s',async(same,outcome)=>{
  const f=fixture([{rowCount:0,rows:[]},{rowCount:0,rows:[]},{rowCount:1,rows:[{same,collision_detected:false}]},...(!same ? [{rowCount:1,rows:[]}] : [])]);
  expect(await f.repo.receive(context,message)).toBe(outcome);
  expect(f.query.mock.calls[3]![0]).toContain('FOR UPDATE');
  if (!same) {
   expect(f.query.mock.calls[4]![0]).toContain("state=CASE WHEN state='completed' THEN state ELSE 'quarantined' END");
   expect(f.query.mock.calls[4]![0]).toContain('lease_token=NULL, lease_until=NULL');
  }
 });
 it('retains collision status on replay, including an already completed row',async()=>{
  const f=fixture([{rowCount:0,rows:[]},{rowCount:0,rows:[]},{rowCount:1,rows:[{same:true,collision_detected:true}]},{rowCount:1,rows:[]}]);
  expect(await f.repo.receive(context,message)).toBe('collision');
  const sql=f.query.mock.calls[4]![0];
  expect(sql).toContain("WHEN state='completed' THEN state");
  expect(sql).not.toContain('pairing_outcome=');
  expect(sql).not.toContain('completed_at=');
 });
 it('keeps identical message IDs distinct across account and peer scopes',async()=>{
  for(const [account,peer] of [['account','sender'],['account2','sender'],['account','sender2']]) {
   const scoped={...identity,accountId:account!,peer:{type:'user' as const,id:peer!}};
   const f=fixture([{rowCount:0,rows:[]},{rowCount:1,rows:[{}]}]);
   expect(await f.repo.receive({platform:'qq',verifiedAccountId:account!},{...message,identity:scoped,senderId:peer!})).toBe('inserted');
   expect(f.query.mock.calls[2]![1]?.slice(0,6)).toEqual(['qq',account,'user',peer,'server','m1']);
  }
 });
 it('quarantines ambiguous legacy IDs without copying or processing them',async()=>{
  const f=fixture([{rowCount:1,rows:[{}]}]);
  expect(await f.repo.receive(context,message)).toBe('legacy');
  expect(f.query.mock.calls.some(c=>c[0].includes('INSERT'))).toBe(false);
 });
 it.each(['would-be valid', 'stale'] as const)('refuses generic completion for a %s lease without checking the database',async(state)=>{
  // These responses model the old transactional lookup; fail-closed completion must not consume either.
  const replies = state === 'would-be valid' ? [{rowCount:1,rows:[{payload:message}]}] : [{rowCount:0,rows:[]}];
  const f=fixture(replies); const work=vi.fn(async()=>1);
  await expect(f.repo.complete(lease,work)).rejects.toThrow('trusted adapter generation verification');
  expect(work).not.toHaveBeenCalled();
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
  expect(replies).toHaveLength(1);
 });
 it('defers pairing even when the payload contains a valid code',async()=>{
  const f=fixture([{rowCount:1,rows:[{payload:{...message,text:'12345678'}}]},{rowCount:1,rows:[]}]);
  expect(await f.repo.processPairing(lease)).toEqual({status:'unsupported'});
  expect(f.query.mock.calls[2]![0]).toContain("state='deferred'");
  expect(f.query.mock.calls[2]![0]).toContain('lease_token=$7::uuid');
  expect(f.query.mock.calls.some(c=>c[0].includes('pairing_code'))).toBe(false);
  const expired=fixture([{rowCount:1,rows:[{payload:message}]},{rowCount:0,rows:[]}]);
  await expect(expired.repo.processPairing(lease)).rejects.toThrow('lease expired during deferral');
  expect(expired.query.mock.calls.at(-1)![0]).toBe('ROLLBACK');
 });
 it('claims only scoped rows with database clock and full key join',async()=>{
  const f=fixture([{rowCount:1,rows:[{platform:'qq',account_id:'account',peer_type:'user',peer_id:'sender',namespace:'server',message_id:'m1',payload:message}]}]);
  expect(await f.repo.claim(1000)).toMatchObject({platform:'qq',identity,message});
  expect(f.query.mock.calls[0]![0]).toContain('FOR UPDATE SKIP LOCKED');
  expect(f.query.mock.calls[0]![0]).toContain('candidate.account_id,candidate.peer_type,candidate.peer_id');
 });
});
