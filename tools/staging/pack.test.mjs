import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { buildArchive } from './pack.mjs';
const names=['core/package.json','core/package-lock.json','core/dist/main.js','core/migrations/001.sql','packages/protocol/package.json','packages/protocol/package-lock.json','packages/protocol/dist/index.js','web/dist/index.html','tools/staging/install.mjs'];
async function fixture() { const dir=await mkdtemp(path.join(os.tmpdir(),'voip-pack-')); for(const name of names) {const p=path.join(dir,name);await mkdir(path.dirname(p),{recursive:true});await writeFile(p,name);} return dir; }
test('archive is deterministic and excludes unrelated secrets and dependencies',async()=>{const dir=await fixture();try {await writeFile(path.join(dir,'.env'),'SECRET');await mkdir(path.join(dir,'core/node_modules'),{recursive:true});await writeFile(path.join(dir,'core/node_modules/secret'),'SECRET');const a=await buildArchive(dir),b=await buildArchive(dir);assert.deepEqual(a,b);const text=gunzipSync(a).toString();for(const name of names) assert.ok(text.includes(name));assert.ok(!text.includes('SECRET'));}finally{await rm(dir,{recursive:true,force:true});}});

test('rejects symlinked input ancestors',async t=>{const dir=await fixture();const target=await mkdtemp(path.join(os.tmpdir(),'voip-link-'));try {await rm(path.join(dir,'web'),{recursive:true});try {await symlink(target,path.join(dir,'web'),'junction');} catch(e) {if(e.code==='EPERM'){t.skip('symlink permission unavailable');return;}throw e;} await assert.rejects(buildArchive(dir),/symlink forbidden/);}finally{await rm(dir,{recursive:true,force:true});await rm(target,{recursive:true,force:true});}});
test('installer preflights both dependency paths',async()=>{const {assertFresh}=await import('./install.mjs');const dir=await fixture();try {await assertFresh(dir);await mkdir(path.join(dir,'core/node_modules'));await assert.rejects(assertFresh(dir),/Refusing existing dependency path/);}finally{await rm(dir,{recursive:true,force:true});}});
test('missing build output and forbidden nested files fail closed',async()=>{const dir=await fixture();try {await rm(path.join(dir,'web/dist/index.html'));await assert.rejects(buildArchive(dir));await writeFile(path.join(dir,'web/dist/index.html'),'ok');await writeFile(path.join(dir,'web/dist/.env'),'secret');await assert.rejects(buildArchive(dir),/forbidden path/);}finally{await rm(dir,{recursive:true,force:true});}});
