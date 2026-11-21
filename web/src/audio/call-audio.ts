import captureUrl from './worklets/capture.worklet.ts?worker&url';
import playbackUrl from './worklets/playback.worklet.ts?worker&url';
import { microphoneAvailable } from './secure-context';
import { openMediaTransport, type MediaFlags } from './media-transport';

type MediaCallbacks = { onFlags: (flags: MediaFlags) => void; onClosed: () => void };
export type PreparedCallAudio = {
  attach: (path: string, token: string, callbacks: MediaCallbacks) => void;
  close: () => void;
  usable: () => boolean;
};

function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export async function prepareCallAudio(signal?: AbortSignal): Promise<PreparedCallAudio> {
  if (!microphoneAvailable()) throw new Error('Microphone unavailable');
  signal?.throwIfAborted();
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  let transport: ReturnType<typeof openMediaTransport> | undefined;
  let capture: AudioWorkletNode | undefined;
  let playback: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let callbacks: MediaCallbacks | undefined;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', close);
    try { transport?.close(); } catch { /* Continue releasing local audio if the socket failed. */ }
    if (capture) { capture.port.onmessage = null; capture.onprocessorerror = null; capture.port.close(); }
    if (playback) { playback.onprocessorerror = null; playback.port.close(); }
    for (const node of [source, capture, playback]) {
      try { node?.disconnect(); } catch { /* This node may already be disconnected. */ }
    }
    for (const track of stream?.getTracks() ?? []) { track.removeEventListener('ended', lost); track.stop(); }
    if (context && context.state !== 'closed') void context.close().catch(() => {});
    callbacks = undefined;
  }

  function lost() {
    if (closed) return;
    const notify = callbacks?.onClosed;
    close();
    notify?.();
  }

  signal?.addEventListener('abort', close, { once: true });
  try {
    // Begin audio resume during the user gesture. The graph stays disconnected until attach.
    try { context = new AudioContext({ sampleRate: 48_000 }); }
    catch { context = new AudioContext(); }
    const resume = context.resume();
    void resume.catch(() => {});
    const microphone = navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } }).then(value => {
      if (closed) { value.getTracks().forEach(track => track.stop()); throw new Error('Audio preparation cancelled'); }
      stream = value;
      for (const track of value.getTracks()) track.addEventListener('ended', lost, { once: true });
      if (!value.getAudioTracks().some(track => track.readyState === 'live')) throw new Error('No live microphone track');
      return value;
    });
    const worklet = (url: string) => Promise.resolve().then(() => context!.audioWorklet.addModule(url));
    const [input] = await waitFor(Promise.all([microphone, resume, worklet(captureUrl), worklet(playbackUrl)]), signal);
    if (closed || context.state !== 'running') throw new Error('Audio preparation cancelled');
    capture = new AudioWorkletNode(context, 'voip-capture');
    playback = new AudioWorkletNode(context, 'voip-playback');
    capture.onprocessorerror = playback.onprocessorerror = lost;
    source = context.createMediaStreamSource(input);
    const usable = () => !closed && context?.state === 'running' && input.getAudioTracks().some(track => track.readyState === 'live');
    return {
      attach(path, token, handlers) {
        if (!usable() || transport || !context || !source || !capture || !playback) throw new Error('Audio is unavailable');
        callbacks = handlers;
        try {
          transport = openMediaTransport(path, token, (samples, flags) => {
            if (!closed) { playback?.port.postMessage(samples); callbacks?.onFlags(flags); }
          }, lost);
          capture.port.onmessage = (event: MessageEvent<unknown>) => {
            if (!closed && event.data instanceof Float32Array) {
              try { transport?.send(event.data); } catch { lost(); }
            }
          };
          source.connect(capture);
          capture.connect(context.destination);
          playback.connect(context.destination);
        } catch (error) { close(); throw error; }
      },
      close,
      usable,
    };
  } catch (error) { close(); throw error; }
}

export async function startCallAudio(path: string, token: string, onFlags: MediaCallbacks['onFlags'], onClosed: MediaCallbacks['onClosed']) {
  const audio = await prepareCallAudio();
  audio.attach(path, token, { onFlags, onClosed });
  return { close: async () => { audio.close(); } };
}
