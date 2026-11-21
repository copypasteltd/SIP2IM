import type { Writable } from 'node:stream';

export function inventorySink(stream: Writable): (record: unknown) => Promise<void> {
  let failure: Error | undefined;
  stream.on('error', error => { failure = error; });
  return async record => {
    if (failure || stream.destroyed) throw failure ?? new Error('output closed');
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { stream.off('close', onClose); stream.off('error', onError); };
      const onClose = () => { cleanup(); reject(new Error('output closed')); };
      const onError = (error: Error) => { cleanup(); reject(error); };
      stream.once('close', onClose); stream.once('error', onError);
      try { stream.write(JSON.stringify(record) + '\n', error => { cleanup(); if (error) reject(error); else resolve(); }); }
      catch (error) { cleanup(); reject(error); }
    });
  };
}
