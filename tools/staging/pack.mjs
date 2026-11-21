import { readdir, readFile, lstat, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const inputs = ['core/package.json','core/package-lock.json','core/dist','core/migrations','packages/protocol/package.json','packages/protocol/package-lock.json','packages/protocol/dist','web/dist','tools/staging/install.mjs'];
const forbidden = /^(node_modules|\.git|\.env(?:\..*)?|config\.toml|.*\.(?:pem|key|p12|pfx|jks|keystore|session))$/i;
function octal(n, width) { const s = n.toString(8); if (s.length > width - 1) throw Error('tar value too large'); return s.padStart(width - 1, '0') + '\0'; }
function entry(name, bytes) {
  if (Buffer.byteLength(name) > 100) throw Error('tar path too long: ' + name);
  const h = Buffer.alloc(512); h.write(name); h.write(octal(0o644,8),100); h.write(octal(0,8),108); h.write(octal(0,8),116); h.write(octal(bytes.length,12),124); h.write(octal(0,12),136); h.fill(32,148,156); h.write('0',156); h.write('ustar\0',257); h.write('00',263);
  let sum=0; for (const b of h) sum+=b; h.write(octal(sum,8),148);
  return [h,bytes,Buffer.alloc((512-bytes.length%512)%512)];
}
export async function buildArchive(source) {
  const chunks=[];
  async function visit(rel) {
    const absolute=path.join(source,...rel.split('/')); const s=await lstat(absolute);
    if (s.isSymbolicLink()) throw Error('symlink forbidden: '+rel);
    if (rel.split('/').some(part=>forbidden.test(part))) throw Error('forbidden path: '+rel);
    if (s.isDirectory()) { const names=(await readdir(absolute)).sort(); if (!names.length) throw Error('empty input directory: '+rel); for (const name of names) await visit(rel+'/'+name); }
    else if (s.isFile()) chunks.push(...entry(rel,await readFile(absolute))); else throw Error('unsupported input: '+rel);
  }
  for (const input of inputs) {
    const parts=input.split('/');
    for (let i=1;i<parts.length;i++) {
      const ancestor=parts.slice(0,i).join('/');
      if ((await lstat(path.join(source,...parts.slice(0,i)))).isSymbolicLink()) throw Error('symlink forbidden: '+ancestor);
    }
    await visit(input);
  }
  return gzipSync(Buffer.concat([...chunks,Buffer.alloc(1024)]),{level:9,mtime:0});
}
async function main() {
  const out=process.argv[2]; if (!out) throw Error('usage: node tools/staging/pack.mjs OUTPUT.tgz');
  const destination=path.resolve(out); await mkdir(path.dirname(destination),{recursive:true});
  const data=await buildArchive(root); await writeFile(destination,data,{flag:'wx'}); console.log('Created '+destination);
}
if (process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) main().catch(e=>{console.error(e.message);process.exitCode=1});
