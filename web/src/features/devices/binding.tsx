import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
import { Countdown } from '../../components/ui/countdown';
import { QrCode } from '../../components/ui/qr-code';
import { Status } from '../../components/ui/status';
import { activeSession, useSession } from '../../stores/session';
import {
  cancelBindingRecord, issueBindingCode, readBindingRecords, type BindingRecord, type Cancellation, type IssuedCode,
} from './binding-api';

const requestTimeoutMs = 15_000;

// A dialog owns one request at a time. Aborting delivery cannot undo a write at Core.
function useOwnedBindingRequest(ownerVersion: number) {
  const pending = useRef<{ controller: AbortController; timer: ReturnType<typeof setTimeout> } | null>(null);
  const stop = useCallback(() => {
    const current = pending.current;
    if (!current) return;
    pending.current = null;
    clearTimeout(current.timer);
    current.controller.abort();
  }, []);
  useEffect(() => stop, [stop]);

  function run<T>(task: (signal: AbortSignal) => Promise<T>, start: () => void,
    success: (result: T) => void, failure: (error: unknown) => void) {
    const owner = activeSession();
    if (!owner || pending.current || useSession.getState().version !== ownerVersion) return;
    const controller = new AbortController();
    const owns = () => activeSession() === owner && useSession.getState().version === ownerVersion;
    const settle = (notify: () => void) => {
      if (pending.current?.controller !== controller) return;
      clearTimeout(pending.current.timer);
      pending.current = null;
      if (owns()) notify();
    };
    const timer = setTimeout(() => {
      controller.abort();
      settle(() => failure(new Error('Binding request timed out')));
    }, requestTimeoutMs);
    pending.current = { controller, timer };
    start();
    void task(controller.signal).then(result => settle(() => success(result)), error => settle(() => failure(error)));
  }

  return { run, stop };
}

function BindingTime({ value }: { value: number }) {
  const { i18n } = useTranslation();
  return <time dateTime={new Date(value).toISOString()}>{new Intl.DateTimeFormat(i18n.language, {
    dateStyle: 'short', timeStyle: 'medium', hourCycle: 'h23',
  }).format(value)}</time>;
}

type Receipt = Pick<IssuedCode, 'expiresAt' | 'recordId'>;
type Issuance = { kind: 'idle' | 'pending' | 'unavailable' | 'unknown' }
  | { kind: 'issued'; code: IssuedCode }
  | { kind: 'expired'; receipt: Receipt };

function IssueBindingCode({ ownerVersion }: { ownerVersion: number }) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [issuance, setIssuance] = useState<Issuance>({ kind: 'idle' });
  const { run, stop } = useOwnedBindingRequest(ownerVersion);
  const receipt = issuance.kind === 'issued' ? issuance.code : issuance.kind === 'expired' ? issuance.receipt : null;
  const usableCode = issuance.kind === 'issued' && Date.now() < issuance.code.expiresAt ? issuance.code : null;

  useEffect(() => {
    if (issuance.kind !== 'issued') return;
    const { recordId, expiresAt } = issuance.code;
    let timer: ReturnType<typeof setTimeout>;
    function checkExpiry() {
      clearTimeout(timer);
      const remaining = expiresAt - Date.now();
      if (remaining > 0) timer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647));
      else setIssuance(current => current === issuance ? { kind: 'expired', receipt: { recordId, expiresAt } } : current);
    }
    checkExpiry();
    document.addEventListener('visibilitychange', checkExpiry);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', checkExpiry);
    };
  }, [issuance]);

  function reset() {
    stop();
    setIssuance({ kind: 'idle' });
  }

  function open() {
    if (!dialog.current || dialog.current.open) return;
    dialog.current.showModal();
    run(issueBindingCode, () => setIssuance({ kind: 'pending' }),
      code => setIssuance({ kind: 'issued', code }), error => {
        setIssuance({ kind: error instanceof ApiError && error.status === 404 ? 'unavailable' : 'unknown' });
      });
  }

  const pending = issuance.kind === 'pending';
  return <>
    <button type="button" className="button" onClick={open}>{t('action.bind')}</button>
    <dialog ref={dialog} aria-labelledby={titleId} onClose={() => { if (!dialog.current?.open) reset(); }}
      onCancel={event => { if (pending) event.preventDefault(); }}>
      <h2 id={titleId}>{t('action.bind')}</h2>
      {pending && <p role="status">{t('loading')}</p>}
      {issuance.kind === 'unavailable' && <p role="alert">{t('binding.issueUnavailable')}</p>}
      {issuance.kind === 'unknown' && <p role="alert">{t('binding.issueUnknown')}</p>}
      {usableCode && <>
        <p className="binding-code">{usableCode.code}</p>
        <p>{t('action.bindHelp')}</p>
        <QrCode value={usableCode.qrPayload}/>
        <p><Countdown expiresAt={usableCode.expiresAt}/></p>
      </>}
      {receipt && <>
        {!usableCode && <p role="status">{t('countdown.expired')}</p>}
        <p>{t('action.expires')}: <BindingTime value={receipt.expiresAt}/></p>
        <p>{t('binding.recordId')}: <span className="mono">{receipt.recordId}</span></p>
      </>}
      <button type="button" className="secondary" disabled={pending} onClick={() => { reset(); dialog.current?.close(); }}>
        {t('action.close')}
      </button>
    </dialog>
  </>;
}

function recordState(record: BindingRecord, now: number) {
  const unused = record.usedAt === null;
  if (unused !== (record.deviceId === null) || unused !== (record.protocolVersion === null)) return 'unknown';
  if (record.teardownPending) return 'teardownPending';
  if (record.cancelledAt !== null) return 'cancelled';
  if (!unused) return 'used';
  return record.expiresAt <= now ? 'expired' : 'unused';
}

const recordSemantics = { unknown: 'unk', teardownPending: 'warn', cancelled: 'unk', used: 'ok', expired: 'unk', unused: 'warn' } as const;
function canReview(state: ReturnType<typeof recordState>) {
  // An expired code can still be tombstoned. A teardown pending row can be reconciled by Core.
  return state !== 'unknown' && state !== 'cancelled';
}

function matchesDevice(previous: BindingRecord, next: BindingRecord) {
  // A code with no observed device can be consumed before Core takes the row lock.
  return previous.deviceId === null || previous.deviceId === next.deviceId;
}

type Inventory = { kind: 'idle' | 'loading' | 'unavailable' | 'error' }
  | { kind: 'ready'; records: BindingRecord[]; nextCursor: string | null };
type CancellationFeedback = { unconfirmed: Map<string, BindingRecord>; confirmed: Cancellation | null };

function BindingInventory({ ownerVersion }: { ownerVersion: number }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const dialog = useRef<HTMLDialogElement>(null);
  const reviewHeading = useRef<HTMLHeadingElement>(null);
  const titleId = useId();
  const recordsName = useId();
  const [inventory, setInventory] = useState<Inventory>({ kind: 'idle' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [review, setReview] = useState<BindingRecord | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [feedback, setFeedback] = useState<CancellationFeedback>(() => ({ unconfirmed: new Map(), confirmed: null }));
  const [clock, setClock] = useState(0);
  const { run, stop } = useOwnedBindingRequest(ownerVersion);
  const selected = inventory.kind === 'ready' ? inventory.records.find(record => record.recordId === selectedId) : undefined;

  function observedState(record: BindingRecord) {
    const previous = feedback.unconfirmed.get(record.recordId);
    return previous && !matchesDevice(previous, record) ? 'unknown' : recordState(record, Date.now());
  }

  useEffect(() => { if (review) reviewHeading.current?.focus(); }, [review]);
  useEffect(() => {
    if (inventory.kind !== 'ready') return;
    const now = Date.now();
    const nextExpiry = inventory.records.reduce((next, record) => record.cancelledAt === null && record.usedAt === null &&
      record.expiresAt > now ? Math.min(next, record.expiresAt) : next, Infinity);
    const update = () => setClock(value => value + 1);
    const timer = Number.isFinite(nextExpiry) ? setTimeout(update, Math.min(nextExpiry - now, 2_147_483_647)) : undefined;
    document.addEventListener('visibilitychange', update);
    return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update); };
  }, [inventory, clock]);

  function load(cursor: string | null = null) {
    const previous = cursor !== null && inventory.kind === 'ready' ? inventory.records : [];
    run(signal => readBindingRecords(cursor, signal), () => {
      setInventory({ kind: 'loading' });
      setReview(null);
      setSelectedId(null);
    }, page => {
      const records = [...previous, ...page.records];
      setInventory({ kind: 'ready', records, nextCursor: page.nextCursor });
      setFeedback(current => {
        if (!current.unconfirmed.size) return current;
        const unconfirmed = new Map(current.unconfirmed);
        let confirmed = current.confirmed;
        for (const row of page.records) {
          const prior = unconfirmed.get(row.recordId);
          if (prior && matchesDevice(prior, row) && recordState(row, Date.now()) === 'cancelled') {
            unconfirmed.delete(row.recordId);
            confirmed = { recordId: row.recordId, deviceId: row.deviceId };
          }
        }
        return unconfirmed.size === current.unconfirmed.size ? current : { confirmed, unconfirmed };
      });
    }, error => setInventory({ kind: error instanceof ApiError && error.status === 404 ? 'unavailable' : 'error' }));
  }

  function reset() {
    stop();
    setInventory({ kind: 'idle' });
    setSelectedId(null);
    setReview(null);
    setCancelling(false);
  }

  function open() {
    if (!dialog.current || dialog.current.open) return;
    dialog.current.showModal();
    load();
  }

  function confirmCancellation() {
    if (!review || review !== selected || !canReview(observedState(review)) || cancelling) return;
    const record = review;
    const finish = (result: Cancellation | null) => {
      setCancelling(false);
      setReview(null);
      setSelectedId(null);
      setInventory({ kind: 'idle' });
      setFeedback(current => {
        const unconfirmed = new Map(current.unconfirmed);
        if (result) unconfirmed.delete(record.recordId);
        else unconfirmed.set(record.recordId, record);
        return { unconfirmed, confirmed: result };
      });
      // Cancellation may have revoked the linked device even when the response was lost.
      void client.invalidateQueries({ queryKey: ['devices'] });
      void client.invalidateQueries({ queryKey: ['dashboard'] });
    };
    run(signal => cancelBindingRecord(record, signal), () => setCancelling(true), finish, () => finish(null));
  }

  return <>
    <button type="button" className="secondary" onClick={open}>{t('binding.inventory')}</button>
    <dialog ref={dialog} aria-labelledby={titleId} onClose={() => { if (!dialog.current?.open) reset(); }}
      onCancel={event => { if (cancelling) event.preventDefault(); }}>
      <h2 id={titleId}>{t('binding.inventory')}</h2>
      {feedback.confirmed && <p role="status">
        {t('binding.cancelledReceipt', { recordId: feedback.confirmed.recordId })}
        {feedback.confirmed.deviceId && <> {t('binding.revokedReceipt', { deviceId: feedback.confirmed.deviceId })}</>}
      </p>}
      {[...feedback.unconfirmed.keys()].map(recordId =>
        <p key={recordId} role="alert">{t('binding.cancelUnknown', { recordId })}</p>
      )}
      {review ? <section>
        <h3 ref={reviewHeading} tabIndex={-1}>{t('binding.confirmTitle')}</h3>
        <p>{t('binding.recordId')}: <span className="mono">{review.recordId}</span></p>
        {review.deviceId && <p>{t('binding.linkedDevice')}: <span className="mono">{review.deviceId}</span></p>}
        <p>{t('binding.cancelEffect')}</p>
        {cancelling && <p role="status">{t('loading')}</p>}
        <div className="action-row">
          <button type="button" className="secondary danger" disabled={cancelling} onClick={confirmCancellation}>
            {t('binding.confirmCancel')}
          </button>
          <button type="button" className="secondary" disabled={cancelling} onClick={() => setReview(null)}>
            {t('binding.backToRecords')}
          </button>
        </div>
      </section> : <>
        {inventory.kind === 'loading' && <p role="status">{t('loading')}</p>}
        {inventory.kind === 'unavailable' && <p role="alert">{t('binding.inventoryUnavailable')}</p>}
        {inventory.kind === 'error' && <p role="alert">{t('binding.inventoryError')}</p>}
        {inventory.kind === 'ready' && (inventory.records.length === 0 ? <p>{t('binding.inventoryEmpty')}</p> : <>
          <p>{t('binding.selectionHelp')}</p>
          <ul className="slot-list">{inventory.records.map(record => {
            const state = observedState(record);
            return <li key={record.recordId}>
              <label className="radio"><input type="radio" name={recordsName} value={record.recordId}
                checked={selectedId === record.recordId} disabled={!canReview(state)} onChange={() => setSelectedId(record.recordId)}/>
              <span className="mono">{record.recordId}</span></label>
              <div><Status semantic={recordSemantics[state]}>{t('binding.states.' + state)}</Status></div>
              <div>{t('binding.createdAt')}: <BindingTime value={record.createdAt}/> · {t('action.expires')}: <BindingTime value={record.expiresAt}/></div>
              {record.deviceId && <div>{t('binding.linkedDevice')}: <span className="mono">{record.deviceId}</span>
                {record.protocolVersion !== null && <> · {t('binding.protocol', { version: record.protocolVersion })}</>}
              </div>}
            </li>;
          })}</ul>
        </>)}
        <div className="action-row">
          {inventory.kind === 'ready' && inventory.records.length > 0 && <button type="button" className="secondary danger"
            disabled={!selected || !canReview(observedState(selected))} onClick={() => {
              if (selected && canReview(observedState(selected))) setReview(selected);
            }}>
            {t('binding.reviewCancel')}
          </button>}
          {inventory.kind === 'ready' && inventory.nextCursor !== null && <button type="button" className="secondary"
            onClick={() => load(inventory.nextCursor)}>{t('loadMore')}</button>}
          <button type="button" className="secondary" disabled={inventory.kind === 'loading'} onClick={() => load()}>
            {t('binding.refresh')}
          </button>
        </div>
      </>}
      <button type="button" className="secondary" disabled={cancelling} onClick={() => { reset(); dialog.current?.close(); }}>
        {t('action.close')}
      </button>
    </dialog>
  </>;
}

export function BindDevice() {
  const session = useSession(state => state.session);
  const ownerVersion = useSession(state => state.version);
  if (!session || session.expiresAt <= Date.now()) return null;
  return <div className="action-row" key={ownerVersion}>
    <IssueBindingCode ownerVersion={ownerVersion}/>
    <BindingInventory ownerVersion={ownerVersion}/>
  </div>;
}
