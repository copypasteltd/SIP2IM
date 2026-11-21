import { Writable } from 'node:stream';
import { expect, it } from 'vitest';
import { inventorySink } from '../src/cli/inventory-sink.js';
it('waits for backpressured writable acceptance', async () => {
  let finish!: (error?: Error | null) => void;
  const stream = new Writable({highWaterMark:1, write(_chunk,_encoding,callback) {finish=callback;}});
  let done=false; const pending=inventorySink(stream)({type:'row'}).then(()=>{done=true;});
  await Promise.resolve(); expect(done).toBe(false); finish(); await pending; expect(done).toBe(true);
});
it('rejects on EPIPE or close without hanging', async () => {
  const broken = new Writable({write(_chunk,_encoding,callback) {callback(Object.assign(new Error('broken'),{code:'EPIPE'}));}});
  await expect(inventorySink(broken)({})).rejects.toThrow('broken');
  const closed = new Writable({write() {}}); const pending=inventorySink(closed)({}); closed.destroy();
  await expect(pending).rejects.toThrow('closed');
});
