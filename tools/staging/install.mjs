import { spawnSync } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export async function assertFresh(root) {
  for (const dir of ['packages/protocol','core']) {
    const target=path.join(root,dir,'node_modules');
    try { await lstat(target); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    throw Error('Refusing existing dependency path: '+target);
  }
}
async function main() {
  if (process.platform !== 'linux') throw Error('Install must run natively on Linux');
  if (Number(process.versions.node.split('.')[0]) !== 22) throw Error('Use Node 22 for staging');
  const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  await assertFresh(root);
  for (const dir of ['packages/protocol','core']) {
    const result=spawnSync('npm',['ci','--omit=dev','--workspaces=false'],{cwd:path.join(root,dir),stdio:'inherit'});
    if (result.error || result.status !== 0) throw result.error ?? Error('npm ci failed in '+dir);
  }
  await import(path.join(root,'packages/protocol/dist/index.js'));
  await import(path.join(root,'core/node_modules/@node-rs/argon2/index.js'));
  console.log('Linux dependencies installed; protocol and native argon2 imports succeeded.');
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1});
