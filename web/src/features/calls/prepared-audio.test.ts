import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareCallAudio } from '../../audio/call-audio';
import { openMediaTransport } from '../../audio/media-transport';

vi.mock('../../audio/secure-context', () => ({ microphoneAvailable: () => true }));
vi.mock('../../audio/media-transport', () => ({ openMediaTransport: vi.fn() }));
const frames = vi.mocked(openMediaTransport);
const getUserMedia = vi.fn();
const contexts: ContextFixture[] = [];
const nodes: WorkletFixture[] = [];
const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });

class TrackFixture extends EventTarget {
  readyState: MediaStreamTrackState = 'live';
  stop = vi.fn(() => { this.readyState = 'ended'; });
}
class ContextFixture {
  state: AudioContextState = 'suspended';
  destination = {};
  source = node();
  audioWorklet = { addModule: vi.fn(async () => {}) };
  createMediaStreamSource = vi.fn(() => this.source);
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  constructor() { contexts.push(this); }
}
class WorkletFixture {
  connect = vi.fn();
  disconnect = vi.fn();
  port = { onmessage: null as ((event: MessageEvent<unknown>) => void) | null, close: vi.fn(), postMessage: vi.fn() };
  constructor() { nodes.push(this); }
}
const stream = (track: TrackFixture) => ({ getTracks: () => [track], getAudioTracks: () => [track] });

beforeEach(() => {
  contexts.length = nodes.length = 0;
  getUserMedia.mockReset(); frames.mockReset();
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('AudioContext', ContextFixture);
  vi.stubGlobal('AudioWorkletNode', WorkletFixture);
});
afterEach(() => vi.unstubAllGlobals());

it('prepares worklets without attaching media and releases the track and socket on audio loss', async () => {
  const track = new TrackFixture();
  getUserMedia.mockResolvedValue(stream(track));
  const transport = { send: vi.fn(), close: vi.fn() };
  frames.mockReturnValue(transport);
  const close = vi.fn();
  const audio = await prepareCallAudio();
  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(contexts[0].audioWorklet.addModule).toHaveBeenCalledTimes(2);
  expect(contexts[0].source.connect).not.toHaveBeenCalled();
  expect(frames).not.toHaveBeenCalled();
  audio.attach('/ws/media?session=fixture&leg=fixture', 'fixture-token', { onFlags: vi.fn(), onClosed: close });
  expect(frames).toHaveBeenCalledOnce();
  const sample = new Float32Array(320);
  nodes[0].port.onmessage?.(new MessageEvent('message', { data: sample }));
  expect(transport.send).toHaveBeenCalledWith(sample);
  track.dispatchEvent(new Event('ended'));
  audio.close();
  expect(close).toHaveBeenCalledOnce();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(transport.close).toHaveBeenCalledOnce();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(nodes.every(worklet => worklet.port.close.mock.calls.length === 1)).toBe(true);
  expect(audio.usable()).toBe(false);
});

it('stops a microphone stream granted after cancellation', async () => {
  let grant!: (value: ReturnType<typeof stream>) => void;
  getUserMedia.mockImplementation(() => new Promise(resolve => { grant = resolve; }));
  const controller = new AbortController();
  const work = prepareCallAudio(controller.signal);
  controller.abort();
  await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  const track = new TrackFixture();
  grant(stream(track));
  await Promise.resolve();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(contexts[0].close).toHaveBeenCalledOnce();
  expect(frames).not.toHaveBeenCalled();
});
