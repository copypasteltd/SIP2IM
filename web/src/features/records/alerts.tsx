import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import {
  acknowledgeAlert, alertReadbackMs, alertsKey, readAlerts, type Alert, type AlertState,
} from '../../api/alerts';
import type { Page } from '../../api/client';
import { ErrorMessage } from '../../components/ui/error-message';
import { useConnection } from '../../realtime/use-admin-socket';

const states: AlertState[] = ['open', 'acked', 'resolved'];
const pageSize = 50;
type CursorStack = (string | null)[];
type Snapshot = { cursors: CursorStack; page: Page<Alert>; updatedAt: number };
type View = {
  filter: AlertState | '';
  cursors: CursorStack;
  fallback?: Snapshot;
  restored?: Snapshot;
  failedDestination?: CursorStack;
};

export function Alerts() {
  const { t, i18n } = useTranslation();
  const stale = useConnection(s => s.state) !== 'connected';
  const client = useQueryClient();
  const [view, setView] = useState<View>({ filter: '', cursors: [null] });
  const { filter, cursors, fallback, restored, failedDestination } = view;
  const cursor = cursors.at(-1) ?? null;
  // One observable query per screen; earlier pages keep only their entry cursors.
  const query = useQuery({
    queryKey: [...alertsKey, 'history', filter, cursor],
    queryFn: ({ signal }) => readAlerts({ limit: pageSize, state: filter || undefined, cursor, signal }),
    initialData: restored?.page,
    initialDataUpdatedAt: restored?.updatedAt,
    gcTime: 0,
    refetchInterval: alertReadbackMs,
  });
  const ack = useMutation({
    mutationFn: acknowledgeAlert,
    retry: false,
    onSettled: () => {
      // A lost response or a 404 is still an error. Read back, never replay the write.
      void client.invalidateQueries({ queryKey: alertsKey });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
  if (fallback && query.data) {
    setView({ filter, cursors });
  } else if (fallback && query.isError) {
    // Restore the displayed page as the poll target. Only an explicit retry revisits the failed cursor.
    setView({ filter, cursors: fallback.cursors, restored: fallback, failedDestination: cursors });
  } else if (restored && query.data) {
    setView({ filter, cursors, failedDestination });
  }
  const page = query.data ?? fallback?.page;
  const visibleCursors = query.data ? cursors : fallback?.cursors ?? cursors;
  const busy = query.isPending || query.isFetching || ack.isPending;
  const dateFormat = new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
  });

  function navigate(nextCursors: CursorStack) {
    if (busy || !query.data || nextCursors.at(-1) === cursor) return;
    setView({ filter, cursors: nextCursors, fallback: { cursors, page: query.data, updatedAt: query.dataUpdatedAt } });
  }

  function retry() {
    if (query.isError || !failedDestination) void query.refetch();
    else navigate(failedDestination);
  }

  return <>
    <h1>{t('alerts')}</h1>
    {stale && <p role="status">{t('dashboardPage.staleHelp')}</p>}
    <label className="field">{t('records.filter')}
      <select value={filter} disabled={ack.isPending} onChange={event => {
        const selected = states.find(state => state === event.target.value) ?? '';
        setView({ filter: selected, cursors: [null] });
      }}>
        <option value="">{t('records.all')}</option>
        {states.map(state => <option key={state} value={state}>{t('records.' + state)}</option>)}
      </select>
    </label>
    <div role="group" aria-label={t('records.alertPages')} className="mb-3 flex flex-wrap items-baseline gap-x-2">
      <button type="button" className="secondary" disabled={busy || visibleCursors.length === 1}
        onClick={() => navigate(visibleCursors.slice(0, -1))}>{t('records.previousPage')}</button>
      <button type="button" className="secondary" disabled={busy || page?.nextCursor == null}
        onClick={() => { if (page?.nextCursor != null) navigate([...visibleCursors, page.nextCursor]); }}>
        {t('records.nextPage')}
      </button>
      <button type="button" className="secondary" disabled={busy || visibleCursors.length === 1}
        onClick={() => navigate([null])}>{t('records.latestPage')}</button>
      <span role="status">{t('records.pageNumber', { page: visibleCursors.length })}</span>
    </div>
    {busy && <p role="status">{t('loading')}</p>}
    {(query.isError || failedDestination) && <div role="alert">
      <p>{t('loadError')}</p>
      <button type="button" className="secondary" disabled={busy} onClick={retry}>{t('records.retry')}</button>
    </div>}
    <ErrorMessage error={ack.error}/>
    <div aria-busy={busy}>
      {page && (page.data.length === 0 ? <p>{t('empty')}</p> :
        <div className="device-list">{page.data.map(row => <article className="panel" key={row.id}>
          <h2>{t('alertType.' + row.type, { defaultValue: row.type })}</h2>
          <p>{row.subjectId} · {row.severity}</p>
          <p>{t('records.state')}: {t('records.' + row.state, { defaultValue: row.state })}</p>
          <p>{row.lastAt ? dateFormat.format(row.lastAt) : t('unknown')}</p>
          {row.detail !== undefined && <details><summary>{t('records.details')}</summary>
            <pre>{JSON.stringify(row.detail, null, 2)}</pre></details>}
          {row.state === 'open' && <button type="button" className="secondary" disabled={busy || !query.data}
            onClick={() => ack.mutate(row.id)}>{t('records.ack')}</button>}
        </article>)}</div>)}
    </div>
  </>;
}
