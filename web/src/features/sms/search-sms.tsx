import { useState, type FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { type SmsMessage } from '../../api/endpoints';
import { request } from '../../api/client';
import { Status } from '../../components/ui/status';
import { statusSemantic } from '../../lib/status-map';
import { useConnection } from '../../realtime/use-admin-socket';

type HistoryDevice = {id: string; name: string; revoked: boolean};
type HistorySim = {id: string; deviceId: string; slot: number; carrier: string | null; number: string | null; retired: boolean; deviceRevoked: boolean};
type SearchMessage = SmsMessage & {deviceId: string; simId: string | null};
type Filters = { deviceId: string; simId: string; peer: string; from: string; to: string };
const empty: Filters = { deviceId: '', simId: '', peer: '', from: '', to: '' };
type SearchFilters = Filters & { fromMs?: number; toExclusiveMs?: number };
function localDay(value: string): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value + 'T00:00:00');
  const [year, month, day] = value.split('-').map(Number);
  if (date.getFullYear() !== year || date.getMonth() + 1 !== month || date.getDate() !== day) return new Date(NaN);
  return date;
}

export function SearchSms() {
  const { t, i18n } = useTranslation();
  const stale = useConnection(s => s.state) !== 'connected';
  const [draft, setDraft] = useState<Filters>(empty);
  const [filters, setFilters] = useState<SearchFilters | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [searchVersion, setSearchVersion] = useState(0);
  const devices = useInfiniteQuery({ queryKey: ['sms', 'history', 'devices'], queryFn: ({pageParam, signal}) => request<HistoryDevice[]>('/api/sms/history/devices?' + new URLSearchParams({limit:'50', ...(pageParam ? {cursor:pageParam} : {})}), {signal}), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined });
  const sims = useInfiniteQuery({ queryKey: ['sms', 'history', 'sims', draft.deviceId], queryFn: ({pageParam, signal}) => request<HistorySim[]>('/api/sms/history/sims?' + new URLSearchParams({limit:'50', ...(draft.deviceId ? {deviceId:draft.deviceId} : {}), ...(pageParam ? {cursor:pageParam} : {})}), {signal}), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined });
  const query = useInfiniteQuery({
    queryKey: ['sms', 'search', filters, searchVersion], enabled: filters !== null,
    initialPageParam: undefined as string | undefined,
    queryFn: ({pageParam, signal}) => {
      const f = filters!;
      const params = new URLSearchParams({limit:'50'});
      if (f.deviceId) params.set('deviceId', f.deviceId);
      if (f.simId) params.set('simId', f.simId);
      if (f.peer.trim()) params.set('peer', f.peer.trim());
      if (f.fromMs !== undefined) params.set('from', String(f.fromMs));
      if (f.toExclusiveMs !== undefined) params.set('toExclusive', String(f.toExclusiveMs));
      if (pageParam) params.set('cursor', pageParam);
      return request<SearchMessage[]>('/api/sms?' + params, {signal});
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const allDevices = devices.data?.pages.flatMap(page => page.data) ?? [];
  const allSims = sims.data?.pages.flatMap(page => page.data) ?? [];
  function submit(event: FormEvent) {
    event.preventDefault();
    const fromMs = localDay(draft.from)?.getTime();
    const end = localDay(draft.to);
    const toStartMs = end?.getTime();
    const nextDay = draft.to ? new Date(draft.to + 'T00:00:00Z') : undefined;
    if (nextDay) nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    const nextDate = nextDay && Number.isFinite(nextDay.getTime()) ? nextDay.toISOString().slice(0, 10) : '';
    const toExclusiveMs = nextDay ? new Date(nextDate + 'T00:00:00').getTime() : undefined;
    if ((draft.from && draft.to && draft.from > draft.to) || [fromMs, toStartMs, toExclusiveMs].some(value => value !== undefined && (!Number.isFinite(value) || value < 0 || value > 8640000000000000))) { setFilters(null); setInvalid(true); return; }
    setInvalid(false); setFilters({...draft, peer: draft.peer.trim(), fromMs, toExclusiveMs}); setSearchVersion(version => version + 1);
  }
  return <section className="panel"><h2>{t('smsSearch.title')}</h2>
    <form onSubmit={submit}>
      <label className="field">{t('smsSearch.device')}<select value={draft.deviceId} onChange={e => setDraft({...draft, deviceId:e.target.value, simId:''})}><option value="">{t('records.all')}</option>{allDevices.map(device => <option key={device.id} value={device.id}>{device.name} · {device.id}{device.revoked ? ' · ' + t('smsSearch.revoked') : ''}</option>)}</select></label>
      {devices.isPending && <p role="status">{t('loading')}</p>}{devices.isError && <p role="alert">{t('loadError')}</p>}
      {devices.hasNextPage && <button type="button" className="secondary" disabled={devices.isFetchingNextPage} onClick={() => {void devices.fetchNextPage();}}>{t('smsSearch.moreDevices')}</button>}
      <label className="field">{t('smsSearch.sim')}<select value={draft.simId} onChange={e => setDraft({...draft,simId:e.target.value})}><option value="">{t('records.all')}</option><option value="null">{t('smsSearch.noSim')}</option>{allSims.map(sim => <option key={sim.id} value={sim.id}>{sim.deviceId} · {t('device.slot')} {sim.slot + 1} · {sim.number ?? t('unknown')} · {sim.id}{sim.retired ? ' · ' + t('smsSearch.retired') : ''}{sim.deviceRevoked ? ' · ' + t('smsSearch.revoked') : ''}</option>)}</select></label>
      {sims.isPending && <p role="status">{t('loading')}</p>}{sims.isError && <p role="alert">{t('loadError')}</p>}
      {sims.hasNextPage && <button type="button" className="secondary" disabled={sims.isFetchingNextPage} onClick={() => {void sims.fetchNextPage();}}>{t('smsSearch.moreSims')}</button>}
      <p>{t('smsSearch.currentMetadata')}</p>
      <label className="field">{t('smsSearch.peer')}<input value={draft.peer} onChange={e => setDraft({...draft,peer:e.target.value})}/></label>
      <label className="field">{t('smsSearch.from')}<input type="date" value={draft.from} onChange={e => setDraft({...draft,from:e.target.value})}/></label>
      <label className="field">{t('smsSearch.to')}<input type="date" value={draft.to} onChange={e => setDraft({...draft,to:e.target.value})}/></label>
      {invalid && <p role="alert">{t('smsSearch.invalidRange')}</p>}
      <button type="submit">{t('device.searchButton')}</button>{' '}<button type="button" className="secondary" onClick={() => {setDraft(empty);setFilters(null);setInvalid(false);}}>{t('smsSearch.clear')}</button>
    </form>
    {filters && <div><h3>{t('smsSearch.results')}</h3>{stale && <p role="status">{t('dashboardPage.staleHelp')}</p>}{query.isPending ? <p role="status">{t('loading')}</p> : query.isError && !query.data ? <p role="alert">{t('loadError')}</p> : <>{!query.data?.pages.some(page => page.data.length) && <p>{t('smsSearch.noResults')}</p>}<ol className="message-list">{query.data?.pages.flatMap(page => page.data).map(message => <li className="message" key={message.id}><strong>{t(message.direction === 'in' ? 'smsPage.inbound' : 'smsPage.outbound')} · {message.peer}</strong><p>{message.body}</p><p>{t('smsSearch.recordedAttribution')} · {t('smsSearch.deviceId')}: {message.deviceId} · {t('smsSearch.simId')}: {message.simId ?? t('smsSearch.noSim')}</p><time>{new Intl.DateTimeFormat(i18n.language,{dateStyle:'short',timeStyle:'medium'}).format(message.occurredAt)}</time>{message.task && <Status semantic={statusSemantic('sms',message.task.state,stale)}>{stale ? t('unknown') : t('smsPage.states.' + message.task.state,{defaultValue:t('unknown')})}</Status>}</li>)}</ol>{query.isError && <p role="alert">{t('loadError')}</p>}{query.hasNextPage && <button className="secondary" disabled={query.isFetchingNextPage} onClick={() => {void query.fetchNextPage();}}>{t('loadMore')}</button>}</>}</div>}
  </section>;
}
