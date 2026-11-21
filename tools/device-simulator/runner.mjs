import {createDevice} from './device.mjs';

export async function bindDevice(server, code, fetcher=fetch) {
 const base=new URL(server); if(!['ws:','wss:'].includes(base.protocol)) throw Error('server must use ws or wss');
 base.protocol=base.protocol==='wss:'?'https:':'http:'; base.pathname='/api/device/bind'; base.search='';
 const response=await fetcher(base,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({code,manufacturer:'Simulator',model:'Virtual',apiLevel:34,apkVersion:'0.1.0',apkCode:1,locale:'en'}),redirect:'error'});
 if(!response.ok) throw Error('binding HTTP '+response.status); const result=await response.json();
 if(!result?.data?.deviceId || !result?.data?.token) throw Error('invalid binding response'); return result.data;
}
export function createSession({ token, send, now = Date.now, simCount = 1, openMedia, createCallDriver }) {
  const device = createDevice({ token, now, simCount });
  const pending = new Map();
  const counts = { sent: 0, received: 0, errors: 0 };
  const latencies = [];
  // The original direct runner entry remains available to generationless callers.
  let current = createCallDriver ? null : { send, ready: false };

  function transmit(connection, event, queue = false) {
    if (current !== connection) return;
    // A synchronous fake can replace the socket or ACK during send. Keep call
    // evidence ineligible for replay until this write returns successfully.
    const entry = queue ? { event } : pending.get(event.id);
    if (queue) pending.set(event.id, entry);
    const writingCall = entry && connection.calls && event.type === 'call.state';
    if (writingCall) entry.writing = connection;
    try {
      const result = connection.send(JSON.stringify(event));
      if (connection.calls) {
        if (typeof result?.then === 'function') {
          void Promise.resolve(result).catch(() => {});
          throw new Error('Injected send must finish synchronously');
        }
        if (result === false || result instanceof Error || result?.ok === false || result?.error != null) {
          throw new Error('Injected send failed');
        }
      }
    } catch (error) {
      if (writingCall) {
        entry.acknowledgedAt = undefined;
        if (queue) pending.delete(event.id);
      }
      if (connection.calls) close(connection);
      throw error;
    } finally {
      if (writingCall) entry.writing = null;
    }
    counts.sent++;
    if (writingCall && entry.acknowledgedAt !== undefined) complete(entry, entry.acknowledgedAt);
  }

  function closeMedia(connection) {
    const media = connection.media;
    connection.media = null;
    try { media?.close(); } catch { counts.errors++; }
  }

  function dispose(connection) {
    if (connection.calls) {
      // A replacement can replay a previously sent terminal observation only.
      // Dialing and active observations belong to the socket that produced them.
      for (const [id, { event }] of pending) {
        if (event.type === 'call.state' && event.payload.state !== 'disconnected') pending.delete(id);
      }
      try { connection.calls.close(); } catch { counts.errors++; }
    }
    closeMedia(connection);
  }

  function close(connection) {
    if (!connection || current !== connection) return;
    current = null;
    dispose(connection);
  }

  function start(sendOnSocket = send) {
    const previous = current;
    const connection = { send: sendOnSocket, ready: false };
    current = connection;
    if (previous) dispose(previous);
    try {
      if (createCallDriver) connection.calls = createCallDriver(() => current === connection && connection.ready);
      const hello = device.hello();
      if (connection.calls) hello.payload.capabilities = { callGeneration: true };
      transmit(connection, hello);
    } catch (error) {
      close(connection);
      throw error;
    }
    return {
      receive: raw => receive(connection, raw),
      close: () => close(connection),
      heartbeat: () => heartbeat(connection),
    };
  }

  function complete({ event }, acknowledgedAt) {
    pending.delete(event.id);
    latencies.push(acknowledgedAt - event.ts);
  }

  function receive(connection, raw) {
    if (!connection || current !== connection) return;
    counts.received++;
    try {
      const message = JSON.parse(raw);
      if (message.type === 'hello.ok') {
        if (connection.calls && connection.ready) return;
        connection.ready = true;
        transmit(connection, device.snapshot());
        for (const { event, writing } of pending.values()) {
          if (current !== connection) break;
          if (writing) continue;
          if (!event.type.startsWith('call.') || now() - event.ts < 60_000) transmit(connection, event);
          else pending.delete(event.id);
        }
        return;
      }
      if (connection.calls && !connection.ready) return;
      if (message.type === 'ack') {
        const entry = pending.get(message.payload?.refId);
        if (message.payload?.ok !== true || !entry || (connection.calls && message.payload.error !== null)) return;
        if (!entry.writing) complete(entry, now());
        else if (entry.writing === connection) entry.acknowledgedAt ??= now();
        return;
      }
      const call = typeof message.type === 'string' && message.type.startsWith('call.');
      const events = connection.calls && call ? connection.calls.command(message) : device.command(message, leg => {
        if (!openMedia) throw new Error('media unavailable');
        connection.media = openMedia(leg);
      });
      if (!connection.calls && events.length > 1 && events[0].payload.ok &&
          (message.type === 'call.hangup' || message.type === 'call.reject')) closeMedia(connection);
      for (const event of events) transmit(connection, event, event.type === 'sms.result' || event.type === 'call.state');
    } catch {
      counts.errors++;
      if (connection.calls) close(connection);
    }
  }

  function heartbeat(connection) {
    if (connection?.ready) transmit(connection, device.heartbeat());
  }

  function retain(event) {
    pending.set(event.id, { event });
    if (current?.ready) transmit(current, event);
  }

  return {
    start, receive: raw => receive(current, raw), close: () => close(current), heartbeat: () => heartbeat(current),
    sms: (from, body) => retain(device.sms(from, body)),
    incoming: (id, from) => {
      if (createCallDriver) throw new Error('Injected browser-call driver is outbound only');
      retain(device.incoming(id, from));
    },
    report: () => ({ ...counts, pending: pending.size, latenciesMs: [...latencies] }),
  };
}
