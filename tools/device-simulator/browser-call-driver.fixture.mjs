import { id, parseDeviceMessage } from '../../packages/protocol/dist/device.js';
import { envelope } from './device.mjs';

const commandId = id('cmd');

function synchronous(result) {
  if (typeof result?.then === 'function') {
    void Promise.resolve(result).catch(() => {});
    throw new Error('Fake media callbacks must finish synchronously');
  }
  if (result === false || result instanceof Error || result?.ok === false || result?.error != null) {
    throw new Error('Fake media callback failed');
  }
  return result;
}

// Test fixture for createSession's injected createCallDriver. Only the supplied
// fake media can confirm activation, and each control connection owns its call.
export function createBrowserCallDriver({ openMedia, now = Date.now }) {
  const usedGenerations = new Set();
  return isCurrent => {
    let call = null;
    const receipts = new Map();
    const emit = (type, payload) => envelope(type, payload, now());
    const ack = (refId, error = null) => emit('ack', { refId, ok: error === null, error });
    const state = ({ callId, generation }, value, cause = null) =>
      emit('call.state', { callId, generation, state: value, cause });

    function close() {
      const old = call;
      call = null;
      if (old?.media) synchronous(old.media.close());
    }

    function command(message) {
      if (!isCurrent()) return [];
      if (!commandId.safeParse(message.id).success) throw new TypeError('Invalid fake command ID');
      let parsed;
      try { parsed = parseDeviceMessage(message, 'command'); }
      catch { return [ack(message.id, 'BAD_MESSAGE')]; }
      const { id: refId, type, payload } = parsed;
      const signature = JSON.stringify([type, payload]);
      const previous = receipts.get(refId);
      if (previous) return [previous.signature === signature ? previous.ack : ack(refId, 'CONFLICT')];

      let error = null;
      let events = [];
      if (type !== 'call.dial' && type !== 'call.hangup') {
        error = 'CAPABILITY_UNSUPPORTED';
      } else if (payload.generation === undefined) {
        error = 'BAD_MESSAGE';
      } else if (type === 'call.dial') {
        if (call) error = 'DEVICE_BUSY';
        else if (usedGenerations.has(payload.generation)) error = 'CONFLICT';
        else {
          const next = { callId: payload.callId, generation: payload.generation, media: null };
          usedGenerations.add(next.generation);
          call = next;
          let media;
          try {
            media = openMedia(payload.media);
            if (synchronous(media)?.ready !== true || typeof media.close !== 'function') {
              throw new Error('Fake media readiness is required');
            }
            if (isCurrent()) {
              events = [state(next, 'dialing'), state(next, 'active')];
              next.media = media;
              media = null;
            }
          } catch {
            if (call === next) call = null;
            error = 'CAPABILITY_UNSUPPORTED';
          } finally {
            // A failed or replaced attempt still owns any unattached handle.
            try { if (typeof media?.close === 'function') synchronous(media.close()); } catch { /* failed fixture cleanup */ }
          }
        }
      } else if (!call?.media || call.callId !== payload.callId || call.generation !== payload.generation) {
        error = 'CALL_NOT_FOUND';
      } else {
        const ended = call;
        try {
          close();
          events = [state(ended, 'disconnected', 'local_hangup')];
        } catch {
          error = 'TIMEOUT_UNKNOWN';
        }
      }
      if (!isCurrent()) return [];
      const receipt = ack(refId, error);
      receipts.set(refId, { signature, ack: receipt });
      if (receipts.size > 500) receipts.delete(receipts.keys().next().value);
      return [receipt, ...events];
    }

    return { command, close };
  };
}
