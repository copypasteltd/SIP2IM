import { createHash, randomBytes } from 'node:crypto';
import { hash, verify, Algorithm } from '@node-rs/argon2';
export const tokenHash = (token: string): Buffer => createHash('sha256').update(token).digest();
export const newToken = (): string => randomBytes(32).toString('base64url');
export const hashPassword = (password: string): Promise<string> => hash(password, { algorithm: Algorithm.Argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
export const verifyPassword = (encoded: string, password: string): Promise<boolean> => verify(encoded, password);
export interface Admin { id: string; passwordHash: string; failedCount: number; lockedUntil: Date | null }
export interface AuthRepository {
 // Must lock the administrator row until this callback and its writes finish.
 withAdmin<T>(username: string, fn: (admin: Admin | null, tx: AuthTransaction) => Promise<T>): Promise<T>;
 findSession(hash: Buffer, now: Date): Promise<string | null>;
}
export interface AuthTransaction { setFailure(id: string, count: number, until: Date | null): Promise<void>; createSession(id: string, hash: Buffer, expires: Date): Promise<void>; setPassword(id: string, hash: string): Promise<void>; revokeSessions(id: string): Promise<void> }
export class AuthService {
 constructor(private readonly repo: AuthRepository, private readonly now: () => number = Date.now) {}
 async login(username: string, password: string): Promise<{ token: string; expiresAt: number } | { locked: true } | null> { return this.repo.withAdmin(username, async (admin, tx) => { const now = this.now(); if (!admin) return null; if (admin.lockedUntil && admin.lockedUntil.getTime() > now) return {locked:true}; if (!await verifyPassword(admin.passwordHash,password)) { const count = admin.failedCount + 1; await tx.setFailure(admin.id,count,count >= 10 ? new Date(now + 900000) : null); return null; } await tx.setFailure(admin.id,0,null); const token = newToken(); const expiresAt = now + 7*86400000; await tx.createSession(admin.id,tokenHash(token),new Date(expiresAt)); return {token,expiresAt}; }); }
 async authenticate(token: string): Promise<string | null> { return this.repo.findSession(tokenHash(token),new Date(this.now())); }
 async changePassword(username: string, oldPassword: string, newPassword: string): Promise<boolean> { return this.repo.withAdmin(username,async (admin,tx) => { if (!admin || !await verifyPassword(admin.passwordHash,oldPassword)) return false; await tx.setPassword(admin.id,await hashPassword(newPassword)); await tx.revokeSessions(admin.id); return true; }); }
}
