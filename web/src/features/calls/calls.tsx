import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { management } from '../../api/management';
import { useConnection } from '../../realtime/use-admin-socket';
import { BrowserDialer } from './browser-dialer';

export function Calls() {
  const { t, i18n } = useTranslation();
  const disconnected = useConnection(state => state.state !== 'connected');
  const query = useInfiniteQuery({ queryKey: ['calls'], queryFn: ({ pageParam, signal }) => management.calls(pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined });
  const calls = query.data?.pages.flatMap(page => page.data) ?? [];
  return <><h1>{t('calls')}</h1><p>{t('capability.callRecordNotice')}</p><BrowserDialer/><p id="hangup-unavailable">{t('action.hangupUnavailable')}</p>
    {query.data && <><p>{t('callSnapshot.listTime')}: <time dateTime={new Date(query.dataUpdatedAt).toISOString()}>{new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'medium', hourCycle: 'h23' }).format(query.dataUpdatedAt)}</time></p><p>{t('callSnapshot.listNotice')}</p>{disconnected && <p role="status">{t('callSnapshot.disconnected')}</p>}<button type="button" className="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('callSnapshot.refreshList')}</button></>}
    {query.isPending && <p role="status">{t('loading')}</p>}
    {query.isError && <p role="alert">{query.data && !query.isFetchNextPageError ? t('callSnapshot.failed') + ' ' : ''}{t('loadError')}</p>}
    {query.isError && !query.isFetchNextPageError && <button type="button" className="secondary" disabled={query.isFetching} onClick={() => { void query.refetch(); }}>{t('callDetail.retry')}</button>}
    {query.data && <>
      {calls.length === 0 && !query.hasNextPage && !query.isError && <p>{t('empty')}</p>}
      <div className="device-list">{calls.map(call => <article className="panel" key={call.id}><h2><Link to={'/calls/' + encodeURIComponent(call.id)}>{call.peer ?? t('unknown')}</Link></h2><p>{t('action.callState')}: {call.state} · {new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium', timeStyle: 'short', hourCycle: 'h23' }).format(call.startedAt)}</p><p>{call.platform ?? t('unknown')} · {call.endCause ?? t('unknown')}</p>{(call.state === 'unknown' || call.state === 'rejecting') && <p>{t('capability.bridgeUnconfirmed')}</p>}{call.endedAt === null && <button type="button" className="secondary danger" aria-disabled="true" aria-describedby="hangup-unavailable">{t('action.hangup')}</button>}</article>)}</div>
      {query.hasNextPage && <button type="button" className="secondary" disabled={query.isFetching} onClick={() => { void query.fetchNextPage(); }}>{t(query.isFetchingNextPage ? 'loading' : query.isFetchNextPageError ? 'action.retryCallsPage' : 'loadMore')}</button>}
    </>}
  </>;
}
