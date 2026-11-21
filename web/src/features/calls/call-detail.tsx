import { useState } from 'react';
import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ApiError, request } from '../../api/client';
import { useConnection } from '../../realtime/use-admin-socket';

type CallSummary = { peer: string | null; state: string; legs: { id: string; type: string; state: string }[] };
type CallEvent = { id: string; event: string; ts: number };
const unavailable = (error: unknown) => error instanceof ApiError && (error.status === 404 || error.status === 405);

let nextGeneration = 0;

function Events({ sessionId }: { sessionId: string }) {
  const { t, i18n } = useTranslation();
  const [generation, setGeneration] = useState(() => ++nextGeneration);
  const [previous, setPrevious] = useState<InfiniteData<{ data: CallEvent[]; nextCursor?: string | null }>>();
  const query = useInfiniteQuery({
    queryKey: ['calls', sessionId, 'events', generation],
    queryFn: ({ pageParam, signal }) => request<CallEvent[]>('/api/calls/' + encodeURIComponent(sessionId) + '/events?' + new URLSearchParams({ limit: '50', ...(pageParam ? { cursor: pageParam } : {}) }), { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: page => page.nextCursor ?? undefined,
    staleTime: 'static', gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchOnMount: false, retry: false,
  });
  const shownData = query.data ?? previous;
  const seen = new Set<string>();
  const events = (shownData?.pages.flatMap(page => page.data) ?? []).filter(event => {
    if (seen.has(event.id)) return false;
    seen.add(event.id); return true;
  });
  const errorText = unavailable(query.error) ? t('callDetail.unavailable') : query.error instanceof ApiError && query.error.code === 'EVENT_TOO_LARGE' ? t('callDetail.tooLarge') : t('loadError');
  return <section className="panel" aria-busy={query.isFetching}>
    <h2>{t('settingsPage.events')}</h2>
    <p>{t('callDetail.liveNotice')}</p>
    <button className="secondary" disabled={query.isFetching} onClick={() => { setPrevious(query.data ?? previous); setGeneration(++nextGeneration); }}>{t('callDetail.refresh')}</button>
    {query.isPending && <p role="status">{t('loading')}</p>}
    {query.isError && <p role="alert">{previous && !query.data ? t('callDetail.staleEvents') + ' ' : ''}{errorText}</p>}
    {shownData && events.length === 0 && <p>{t('empty')}</p>}
    <ol>{events.map(event => <li key={event.id}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(event.ts)} · {event.event}</li>)}</ol>
    {query.hasNextPage && <button className="secondary" disabled={query.isFetching} onClick={() => { void query.fetchNextPage(); }}>{t(query.isFetchingNextPage ? 'loading' : query.isFetchNextPageError ? 'callDetail.retryPage' : 'loadMore')}</button>}
    {query.isLoadingError && (!unavailable(query.error) || previous) && <button className="secondary" onClick={() => { void query.refetch(); }}>{t('callDetail.retry')}</button>}
  </section>;
}

export function CallDetailPage() {
  const { t, i18n } = useTranslation();
  const disconnected = useConnection(state => state.state !== 'connected');
  const { sessionId = '' } = useParams();
  const query = useQuery({ queryKey: ['calls', sessionId, 'summary'], queryFn: ({ signal }) => request<CallSummary>('/api/calls/' + encodeURIComponent(sessionId) + '/summary', { signal }), retry: false, refetchInterval: 30_000 });
  return <><Link to="/calls">← {t('calls')}</Link>
    {query.isPending ? <p role="status">{t('loading')}</p> : query.isError && !query.data ? <p role="alert">{unavailable(query.error) ? t('callDetail.unavailable') : t('loadError')}</p> : query.data && <><h1>{query.data.data.peer ?? t('unknown')}</h1><p>{t('capability.callRecordNotice')}</p><p>{t('browserCall.detailNotice')}</p><section className="panel"><h2>{t('action.callState')}: {query.data.data.state}</h2>{(query.data.data.state === 'unknown' || query.data.data.state === 'rejecting') && <p>{t('capability.bridgeUnconfirmed')}</p>}<ul>{query.data.data.legs.map(leg => <li key={leg.id}>{leg.type}: {leg.state}</li>)}</ul></section></>}
    {query.data && <><p>{t('callSnapshot.summaryTime')}: <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(query.dataUpdatedAt)}</time></p><p>{t('callSnapshot.summaryNotice')}</p>{disconnected && <p role="status">{t('callSnapshot.disconnected')}</p>}</>}
    <button type="button" className="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('callSnapshot.refreshSummary')}</button>
    {query.isError && query.data && <p role="alert">{t('callDetail.staleSummary')}</p>}
    <Events key={sessionId} sessionId={sessionId}/>
  </>;
}
