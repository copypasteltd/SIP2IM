import { expect, it } from 'vitest';
import { AuthService, hashPassword, tokenHash, type Admin, type AuthRepository, type AuthTransaction } from '../src/auth/service.js';
it('locks after ten failures, clears failures on success, expires and revokes sessions', async () => {
 let now=1000000; let admin:Admin={id:'admin',passwordHash:await hashPassword('test-value'),failedCount:0,lockedUntil:null}; const sessions=new Map<string,number>();
 const tx:AuthTransaction={setFailure:async (_id,count,until)=>{admin={...admin,failedCount:count,lockedUntil:until};},createSession:async (_id,hash,expires)=>{sessions.set(hash.toString('hex'),expires.getTime());},setPassword:async (_id,hash)=>{admin={...admin,passwordHash:hash};},revokeSessions:async ()=>{sessions.clear();}};
 const repo:AuthRepository={withAdmin:async (_name,fn)=>fn(admin,tx),findSession:async (hash,at)=> (sessions.get(hash.toString('hex'))??0)>at.getTime()?'admin':null};
 const service=new AuthService(repo,()=>now);
 for(let i=0;i<10;i++) expect(await service.login('admin','incorrect')).toBeNull();
 expect(admin.failedCount).toBe(10); expect(await service.login('admin','test-value')).toEqual({locked:true}); now+=900001;
 const session=await service.login('admin','test-value'); expect(session).not.toBeNull(); if(!session || 'locked' in session) throw new Error('expected session'); expect(admin.failedCount).toBe(0); expect(await service.authenticate(session!.token)).toBe('admin'); expect(sessions.has(tokenHash(session!.token).toString('hex'))).toBe(true);
 now=session!.expiresAt; expect(await service.authenticate(session!.token)).toBeNull(); now-=1;
 expect(await service.changePassword('admin','test-value','replacement')).toBe(true); expect(await service.authenticate(session!.token)).toBeNull();
});
