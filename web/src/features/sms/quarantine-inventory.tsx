import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError, request } from '../../api/client';
import { activeSession, useSession, type Session } from '../../stores/session';

const path = '/api/admin/sms-quarantine';
const encoding = 'json-utf16le-v1';
const maxBytes = 262_144;
const pageSize = 25;
const recordId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Row = { id: string; createdAt: string; deviceId: string; eventId: string; reason: string; encoding: typeof encoding; payloadLength: number; state?: 'retained' | 'needs_attention'; deviceTs?: number };
type Page = { data: Row[]; nextCursor?: string | null };
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256;

function validCreatedAt(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parts = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(value);
  if (!parts) return false;
  const zone = parts[4].length === 3 ? parts[4] + ':00' : parts[4];
  const fraction = (parts[3] ?? '').padEnd(3, '0').slice(0, 3);
  return Number.isFinite(Date.parse(parts[1] + 'T' + parts[2] + '.' + fraction + zone));
}

function parseRow(row: unknown): Row {
  if (!record(row) || typeof row.id !== 'string' || row.id.length !== 36 || !recordId.test(row.id) ||
      !validCreatedAt(row.createdAt) ||
      !text(row.deviceId) || !text(row.eventId) || !text(row.reason) || row.encoding !== encoding ||
      typeof row.payloadLength !== 'number' || !Number.isSafeInteger(row.payloadLength) || row.payloadLength < 0 ||
      (row.state === undefined) !== (row.deviceTs === undefined) ||
      (row.state !== undefined && row.state !== 'retained' && row.state !== 'needs_attention') ||
      (row.deviceTs !== undefined && (typeof row.deviceTs !== 'number' || !Number.isSafeInteger(row.deviceTs) || row.deviceTs < 0))) {
    throw new Error('Invalid inventory metadata');
  }
  const { id, createdAt, deviceId, eventId, reason, payloadLength, state, deviceTs } = row;
  return { id, createdAt, deviceId, eventId, reason, encoding, payloadLength, ...(state ? { state } : {}), ...(deviceTs !== undefined ? { deviceTs } : {}) };
}

function parsePage(result: { data: unknown; nextCursor?: string | null }): Page {
  if (!Array.isArray(result.data) || result.data.length > pageSize ||
      (result.nextCursor != null && (typeof result.nextCursor !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(result.nextCursor)))) throw new Error('Invalid inventory page');
  const data = result.data.map((item: unknown) => {
    if (record(item) && Object.hasOwn(item, 'payloadBase64')) throw new Error('Unexpected inventory payload');
    return parseRow(item);
  });
  if (new Set(data.map(row => row.id)).size !== data.length) throw new Error('Duplicate inventory record');
  return { data, nextCursor: result.nextCursor };
}

function parseExport(result: { data: unknown; nextCursor?: string | null }, expected: Row) {
  if (!Array.isArray(result.data) || result.data.length !== 1 || result.nextCursor != null) throw new Error('Invalid export');
  const raw: unknown = result.data[0];
  if (!record(raw)) throw new Error('Invalid export');
  const row = parseRow(raw);
  if (row.id !== expected.id || row.encoding !== expected.encoding || row.payloadLength !== expected.payloadLength || row.deviceId !== expected.deviceId ||
      row.eventId !== expected.eventId || row.createdAt !== expected.createdAt || row.reason !== expected.reason || row.deviceTs !== expected.deviceTs ||
      row.state !== expected.state || row.state === 'needs_attention' || row.payloadLength < 2 || row.payloadLength > maxBytes || row.payloadLength % 2 !== 0) throw new Error('Mismatched export');
  const encoded = raw.payloadBase64;
  if (typeof encoded !== 'string' || encoded.length !== Math.ceil(row.payloadLength / 3) * 4) throw new Error('Invalid export encoding');
  const decoded = atob(encoded);
  if (btoa(decoded) !== encoded || decoded.length !== row.payloadLength) throw new Error('Invalid export encoding');
  const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
  const event: unknown = JSON.parse(new TextDecoder('utf-16le', { fatal: true, ignoreBOM: true }).decode(bytes));
  if (row.deviceTs !== undefined && (!record(event) || event.v !== 1 || event.type !== 'sms.received' ||
      event.id !== row.eventId || event.ts !== row.deviceTs || !record(event.payload))) {
    throw new Error('Mismatched custody event');
  }
  return { data: [{ ...row, payloadBase64: encoded }], nextCursor: null };
}

export function SmsQuarantineInventory() {
  const { t } = useTranslation();
  const [page, setPage] = useState<Page>();
  const [owner, setOwner] = useState<Session>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<'loadFailed' | 'exportFailed' | 'unavailable'>();
  const session = useSession(state => state.session);
  const inFlight = useRef<AbortController | undefined>(undefined);
  const downloads = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const urls = downloads.current;
    function release() {
      inFlight.current?.abort();
      inFlight.current = undefined;
      for (const [url, timer] of urls) { clearTimeout(timer); URL.revokeObjectURL(url); }
      urls.clear();
    }
    const unsubscribe = useSession.subscribe((next, previous) => {
      if (next.session !== previous.session) { release(); setPage(undefined); setOwner(undefined); setBusy(false); setError(undefined); }
    });
    return () => { unsubscribe(); release(); };
  }, []);

  async function run(mode: 'inventory' | 'export', cursor?: string, selected?: Row) {
    if (inFlight.current) return;
    const actor = activeSession();
    if (!actor) { setError('unavailable'); return; }
    if (mode === 'export' && (!selected || owner !== actor || !page?.data.includes(selected))) return;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    inFlight.current = controller;
    const current = () => inFlight.current === controller && actor === useSession.getState().session && actor.expiresAt > Date.now();
    setBusy(true);
    setError(undefined);
    try {
      if (mode === 'inventory') {
        const result = await request<unknown>(path + '?' + new URLSearchParams({ limit: String(pageSize), ...(cursor ? { cursor } : {}) }), { signal: controller.signal, cache: 'no-store' });
        controller.signal.throwIfAborted();
        const next = parsePage(result);
        if (current() && !controller.signal.aborted) { setOwner(actor); setPage(next); }
      } else if (selected) {
        const result = await request<unknown>(path + '/' + encodeURIComponent(selected.id) + '/export', { signal: controller.signal, cache: 'no-store' });
        controller.signal.throwIfAborted();
        const exported = parseExport(result, selected);
        if (!current() || controller.signal.aborted) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = 'sms-quarantine-' + selected.id + '.json';
        link.hidden = true;
        try { document.body.append(link); link.click(); }
        finally {
          link.remove();
          const timer = setTimeout(() => { downloads.current.delete(url); URL.revokeObjectURL(url); }, 1000);
          downloads.current.set(url, timer);
        }
      }
    } catch (cause) {
      if (!current()) return;
      const unavailable = mode === 'inventory' && cause instanceof ApiError && [403, 404, 405, 503].includes(cause.status);
      if (unavailable) { setPage(undefined); setOwner(undefined); }
      setError(unavailable ? 'unavailable' : mode === 'export' ? 'exportFailed' : 'loadFailed');
    } finally {
      clearTimeout(timeout);
      if (inFlight.current === controller) { inFlight.current = undefined; setBusy(false); }
    }
  }

  const visible = session && session === owner ? page : undefined;
  return <section className="panel" aria-busy={busy}>
    <h2>{t('smsQuarantine.title')}</h2>
    <p>{t('smsQuarantine.notice')}</p>
    <button type="button" className="secondary" disabled={busy} onClick={() => { void run('inventory'); }}>{t('smsQuarantine.load')}</button>
    {error && <p role="alert">{t('smsQuarantine.' + error)}</p>}{busy && <p role="status">{t('loading')}</p>}
    {visible && <>{visible.data.length === 0 ? <p>{t('empty')}</p> : <div className="device-list">{visible.data.map(row => <article className="panel" key={row.id}>
      <h3>{row.id}</h3><dl><dt>{t('smsQuarantine.created')}</dt><dd>{row.createdAt}</dd><dt>{t('smsQuarantine.device')}</dt><dd>{row.deviceId}</dd>
        <dt>{t('smsQuarantine.event')}</dt><dd>{row.eventId}</dd><dt>{t('smsQuarantine.reason')}</dt><dd>{row.reason}</dd>
        <dt>{t('smsQuarantine.encoding')}</dt><dd>{row.encoding}</dd><dt>{t('smsQuarantine.bytes')}</dt><dd>{row.payloadLength}</dd>
        {row.state && <><dt>{t('records.state')}</dt><dd>{t('smsQuarantine.' + row.state)}</dd></>}
      </dl>
      {row.state !== 'needs_attention' && row.payloadLength >= 2 && row.payloadLength <= maxBytes && row.payloadLength % 2 === 0
        ? <button type="button" className="secondary" disabled={busy} onClick={() => { void run('export', undefined, row); }}>{t('smsQuarantine.export')}</button>
        : <p>{t('smsQuarantine.exportFailed')}</p>}
    </article>)}</div>}
    {visible.nextCursor && <button type="button" className="secondary" disabled={busy} onClick={() => { void run('inventory', visible.nextCursor ?? undefined); }}>{t('smsQuarantine.next')}</button>}
    </>}
  </section>;
}
