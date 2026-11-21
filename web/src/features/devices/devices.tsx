import { useEffect, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api, type DeviceDetail, type Sim } from '../../api/endpoints';
import { Status } from '../../components/ui/status';
import { statusSemantic } from '../../lib/status-map';
import { DeviceActions } from './device-actions';
import { BindDevice } from './binding';
import { SimActions } from './sim-actions';
import { CallingControl } from './calling-control';
import { useConnection } from '../../realtime/use-admin-socket';
function Time({ value }: { value: number | null }) { const { t, i18n } = useTranslation(); return <>{value ? new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(value) : t('unknown')}</>; }
export function Slots({ sims, stale: queryStale = false }: { sims: Sim[]; stale?: boolean }) { const { t } = useTranslation(); const disconnected=useConnection(s=>s.state)!=='connected'; const [now,setNow]=useState(Date.now); useEffect(()=>{const current=Date.now(); const deadlines=sims.map(sim=>sim.lastSeenAt).filter((at):at is number=>typeof at==='number' && Number.isFinite(at) && at>=0 && at<=current && current-at<=7200000).map(at=>at+7200001); const next=Math.min(...deadlines); if(!Number.isFinite(next)) return; const timer=setTimeout(()=>setNow(Date.now()),Math.max(1,next-current)); return ()=>clearTimeout(timer);},[sims,now]); return <ul className="slot-list">{sims.map(sim => { const at=sim.lastSeenAt; const current=Date.now(); const stale=queryStale || disconnected || typeof at!=='number' || !Number.isFinite(at) || at<0 || at>current || current-at>7200000; return <li key={sim.id}><strong>{t('device.slot')} {sim.slot + 1}</strong> · <span className="mono">{sim.number ?? t('unknown')}</span> · {sim.carrier ?? t('unknown')} · <Status semantic={statusSemantic('sim',sim.state,stale)}>{stale?t('unknown'):t('device.simStates.' + sim.state, { defaultValue: t('unknown') })}</Status>{sim.needsReview && <> · {t('device.review')}</>}</li>; })}</ul>; }
export function DeviceList() { const { t } = useTranslation(); const disconnected=useConnection(s=>s.state)!=='connected'; const [draft, setDraft] = useState(''); const [search, setSearch] = useState(''); const [online, setOnline] = useState('all'); const filters = { ...(search ? { q: search } : {}), ...(online !== 'all' ? { online: online === 'true' } : {}) }; const query = useInfiniteQuery({ queryKey:['devices', filters], queryFn: ({ pageParam, signal }) => api.devices(pageParam, signal, filters), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined }); const [refreshFailureLatched, setRefreshFailureLatched] = useState(false); useEffect(() => { if (query.isRefetchError) setRefreshFailureLatched(true); else if (query.isSuccess && !query.isFetching) setRefreshFailureLatched(false); }, [query.isRefetchError, query.isSuccess, query.isFetching]); const refreshFailed=refreshFailureLatched || query.isRefetchError; const stale=disconnected || query.isError || refreshFailed; return <><div className="page-heading"><h1>{t('devices')}</h1><BindDevice/></div><form className="panel" onSubmit={event => { event.preventDefault(); setSearch(draft.trim()); }}><label className="field">{t('device.search')}<input value={draft} maxLength={200} onChange={event => setDraft(event.target.value)}/></label><label className="field">{t('device.filterStatus')}<select value={online} onChange={event => setOnline(event.target.value)}><option value="all">{t('records.all')}</option><option value="true">{t('online')}</option><option value="false">{t('offline')}</option></select></label><button className="secondary" type="submit">{t('device.searchButton')}</button></form>{query.isPending ? <p role="status">{t('loading')}</p> : query.isLoadingError ? <div role="alert"><p>{t('loadError')}</p><button className="secondary" type="button" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('callDetail.retry')}</button></div> : <>{query.data.pages.flatMap(page => page.data).length === 0 && <p>{t('empty')}</p>}<div className="device-list">{query.data.pages.flatMap(page => page.data).map(device => <article className="panel" key={device.id}><h2><Link to={'/devices/' + encodeURIComponent(device.id)}>{device.name}</Link></h2><p>{t('capability.deviceReachability')}: <Status semantic={stale?'unk':device.online?'ok':'err'}>{t(stale?'unknown':device.online?'online':'offline')}</Status> · {t('device.lastSeen')}: <Time value={device.lastSeenAt}/> · {device.capabilityLevel ?? t('unknown')}</p><Slots sims={device.sims} stale={query.isError || refreshFailed}/></article>)}</div>{(query.isError || refreshFailed) && <div role="alert"><p>{t(query.isFetchNextPageError && !refreshFailed ? 'loadError' : 'device.refreshFailed')}</p>{(!query.isFetchNextPageError || refreshFailed) && <button className="secondary" type="button" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('callDetail.retry')}</button>}</div>}{query.hasNextPage && <button className="secondary" onClick={() => { void query.fetchNextPage(); }} disabled={query.isFetching || refreshFailed}>{t(query.isFetchingNextPage ? 'loading' : 'loadMore')}</button>}</>}</>; }
const hostFreshnessMs = 30_000;
const hostResults = { started: 'ok', failed: 'err', already_running: 'ok' } as const;

function HostShizukuObservation({ value }: { value: DeviceDetail['usbAutostart'] }) {
  const { t, i18n } = useTranslation();
  const [clock, setClock] = useState(0);
  const now = Date.now();
  const report = value && typeof value.serial === 'string' && value.serial.length > 0 && value.serial.length <= 128
    && !/[^A-Za-z0-9._:-]/.test(value.serial) && Number.isSafeInteger(value.lastAt) && value.lastAt >= 0
    && value.lastAt <= now && now - value.lastAt <= hostFreshnessMs && typeof value.lastResult === 'string'
    && Object.hasOwn(hostResults, value.lastResult) ? value : null;
  const deadline = report ? report.lastAt + hostFreshnessMs + 1 : null;

  useEffect(() => {
    if (deadline === null) return;
    const update = () => setClock(current => current + 1);
    const timer = setTimeout(update, Math.max(1, deadline - Date.now()));
    document.addEventListener('visibilitychange', update);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [deadline, clock]);

  const semantic = report ? hostResults[report.lastResult as keyof typeof hostResults] : 'unk';
  return <section className="panel">
    <h2>{t('device.usbAutostart.title')}</h2>
    <p>{t('device.usbAutostart.description')}</p>
    <p><Status semantic={semantic}>{report ? t('device.usbAutostart.results.' + report.lastResult) : t('unknown')}</Status></p>
    {report && <p>
      {t('device.usbAutostart.serial')}: <span className="mono">{report.serial}</span> · {t('device.usbAutostart.observedAt')}: <time dateTime={new Date(report.lastAt).toISOString()}>
        {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(report.lastAt)}
      </time>
    </p>}
  </section>;
}

export function DeviceDetails() { const { t } = useTranslation(); const stale=useConnection(s=>s.state)!=='connected'; const { deviceId = '' } = useParams(); const query = useQuery({ queryKey:['devices',deviceId], queryFn: ({ signal }) => api.device(deviceId,signal), enabled: !!deviceId }); if (query.isPending) return <p role="status">{t('loading')}</p>; if (query.isError) return <p role="alert">{t('loadError')}</p>; const device=query.data.data; return <><Link to="/devices">← {t('devices')}</Link><h1>{device.name}</h1><section className="panel"><h2>{t('device.information')}</h2><p>{device.model} · {device.capabilityLevel ?? t('unknown')} · {t('capability.deviceReachability')}: <Status semantic={stale?'unk':device.online?'ok':'err'}>{t(stale?'unknown':device.online?'online':'offline')}</Status></p><p>{t('device.lastSeen')}: <Time value={device.lastSeenAt}/></p><CallingControl deviceId={device.id} enabled={device.callEnabled}/><Slots sims={device.sims}/>{device.sims.map(sim=><SimActions key={sim.id} sim={sim} deviceId={device.id}/>)}</section><section className="panel"><h2>{t('device.probes')}</h2><p>{t('capability.observedProbe')}</p><ul>{Object.entries(device.probes ?? {}).map(([name,probe]) => <li key={name}>{name}: <Status semantic={statusSemantic('probe',probe.result,stale)}>{stale?t('unknown'):t('device.probeStates.' + probe.result, { defaultValue:t('unknown') })}</Status> · <Time value={probe.probedAt}/></li>)}</ul></section><HostShizukuObservation key={'usb-' + device.id} value={device.usbAutostart}/><DeviceActions key={device.id} device={device}/></>; }
