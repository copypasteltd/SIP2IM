import { copyFile, lstat, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const files=['packages/protocol/package.json','packages/protocol/package-lock.json','packages/protocol/tsconfig.json','core/package.json','core/package-lock.json','core/tsconfig.json','web/package.json','web/package-lock.json','web/tsconfig.json','web/vite.config.ts','web/index.html','tools/staging/pack.mjs','tools/staging/install.mjs'];
const trees=[['packages/protocol/src',/\.(ts|tsx)$/],['core/src',/\.(ts|tsx)$/],['core/migrations',/\.sql$/],['web/src',/\.(ts|tsx|css|json)$/]];
export async function copyInputs(source,destination) {
  async function copy(rel,filter) {
    const parts=rel.split('/');
    for (let i=1;i<=parts.length;i++) {
      const target=path.join(source,...parts.slice(0,i));
      if ((await lstat(target)).isSymbolicLink()) throw Error('symlink forbidden: '+parts.slice(0,i).join('/'));
    }
    const from=path.join(source,...parts), stat=await lstat(from);
    if (stat.isDirectory()) { for (const name of (await readdir(from)).sort()) await copy(rel+'/'+name,filter); }
    else if (stat.isFile() && (!filter || filter.test(rel))) { const to=path.join(destination,...parts); await mkdir(path.dirname(to),{recursive:true}); await copyFile(from,to); }
  }
  for (const file of files) await copy(file);
  for (const [dir,filter] of trees) await copy(dir,filter);
}
async function main() {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw Error('Use Node 22 for staging builds');
  const out=process.argv[2]; if (!out) throw Error('usage: node tools/staging/build.mjs OUTPUT.tgz');
  const destination=path.resolve(out), tmp=await mkdtemp(path.join(os.tmpdir(),'voip-stage-'));
  try {
    await copyInputs(root,tmp);
    const npm=process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const env={PATH:process.env.PATH,HOME:tmp,USERPROFILE:tmp,TEMP:tmp,TMP:tmp,npm_config_cache:path.join(tmp,'.npm-cache')};
    if (process.platform === 'win32') for (const key of ['SystemRoot','ComSpec','PATHEXT']) if (process.env[key]) env[key]=process.env[key];
    for (const dir of ['packages/protocol','core','web']) {
      for (const args of [['ci','--workspaces=false'],['run','build','--workspaces=false']]) {
        const r=spawnSync(npm,args,{cwd:path.join(tmp,dir),stdio:'inherit',env,shell:process.platform === 'win32'});
        if (r.error || r.status !== 0) throw r.error ?? Error(args.join(' ')+' failed: '+dir);
      }
    }
    const r=spawnSync(process.execPath,[path.join(tmp,'tools/staging/pack.mjs'),destination],{cwd:tmp,stdio:'inherit',env});
    if (r.error || r.status !== 0) throw r.error ?? Error('packaging failed');
  } finally { await rm(tmp,{recursive:true,force:true}); }
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1});
