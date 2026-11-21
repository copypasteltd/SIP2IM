import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, request } from '../../api/client';
import { api, type Device, type Sim } from '../../api/endpoints';
import { prepareCallAudio, type PreparedCallAudio } from '../../audio/call-audio';
import { microphoneAvailable } from '../../audio/secure-context';
import { newIdempotencyKey } from '../../lib/idempotency';
import { activeSession, useSession, type Session } from '../../stores/session';

const availabilityKey = ['calls', 'availability'] as const;
const idPattern = (prefix: string) => new RegExp('^' + prefix + '_[0-7][0-9A-HJKMNP-TV-Z]{25}$');
const deviceIdPattern = idPattern('dev');
const simIdPattern = idPattern('sim');
const sessionIdPattern = idPattern('ses');
const legIdPattern = idPattern('leg');
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const matches = (value: unknown, pattern: RegExp): value is string => typeof value === 'string' && pattern.test(value);
const watchedStates = ['awaiting_browser', 'cell_dialing', 'bridged', 'ending', 'ended', 'unknown'] as const;
type CallState = typeof watchedStates[number];
const isCallState = (value: unknown): value is CallState => typeof value === 'string' && watchedStates.some(state => state === value);
const definiteRejections = new Set(['BAD_REQUEST', 'NUMBER_INVALID', 'IDEMPOTENCY_KEY_REQUIRED', 'CAPABILITY_UNSUPPORTED', 'DEVICE_OFFLINE', 'DEVICE_DISABLED', 'DEVICE_BUSY', 'SIM_NOT_FOUND', 'SIM_NOT_READY', 'CALL_NOT_ENABLED', 'CALL_NOT_ACTIVE']);
const rejected = (cause: unknown) => cause instanceof ApiError && cause.status < 500 && definiteRejections.has(cause.code);

type Intent = { key: string; simId: string; deviceId: string; to: string };
type ControlKind = 'hangup' | 'dtmf';
type ControlState = 'pending' | 'accepted' | 'unknown';
type OwnedCall = Pick<Intent, 'deviceId' | 'simId'> & { id: string; legId: string; controls: Partial<Record<ControlKind, ControlState>> };
type ControlTarget = { owner: Session; call: OwnedCall };
type ControlAttempt = ControlTarget & { kind: ControlKind; controller: AbortController; timer?: ReturnType<typeof setTimeout> };
type Attempt = {
  owner: Session; controller: AbortController; prepared?: PreparedCallAudio; sent: boolean;
  mediaTimer?: ReturnType<typeof setTimeout>;
};
type Notice = 'preparing' | 'reserving' | 'audioFailed' | 'unavailable' | 'rejected' | 'reservationUnknown' | 'dtmfSent' | 'controlRejected' | 'summaryStale';
// Keep request identity and control outcomes in this browser session only. Never store the media token here or in the query cache.
const unresolved = new WeakMap<Session, Intent>();
const callRecords = new WeakMap<Session, OwnedCall>();

function releaseAudio(attempt?: Attempt) {
  if (!attempt) return;
  clearTimeout(attempt.mediaTimer);
  const audio = attempt.prepared;
  attempt.prepared = undefined;
  attempt.controller.abort();
  audio?.close();
}

function abandonControl(ref: { current: ControlAttempt | undefined }) {
  const attempt = ref.current;
  if (!attempt) return;
  ref.current = undefined;
  clearTimeout(attempt.timer);
  attempt.call.controls[attempt.kind] = 'unknown';
  attempt.controller.abort();
}

const fresh = (updatedAt: number, now = Date.now()) => updatedAt > 0 && now >= updatedAt && now - updatedAt <= 5_000;
const canHangup = (state: CallState | undefined) => state === 'awaiting_browser' || state === 'cell_dialing' || state === 'bridged';

async function readAvailable(signal?: AbortSignal): Promise<string[]> {
  const result = await request<unknown>('/api/calls/availability', { signal, cache: 'no-store' });
  if (!record(result.data) || !Array.isArray(result.data.deviceIds) || !result.data.deviceIds.every(id => matches(id, deviceIdPattern))) throw Error('Invalid call availability');
  return result.data.deviceIds;
}

function readCallState(value: unknown, owned: OwnedCall): CallState {
  if (!record(value) || value.id !== owned.id || value.kind !== 'web_out' || value.simId !== owned.simId ||
      value.deviceId !== owned.deviceId || !isCallState(value.state) || !Array.isArray(value.legs) ||
      value.legs.filter((leg: unknown) => record(leg) && leg.id === owned.legId && leg.type === 'browser').length !== 1) {
    throw Error('Unrecognized call observation');
  }
  return value.state;
}

function reservation(value: unknown, intent: Intent) {
  if (!record(value) || !record(value.session) || !record(value.browserLeg)) throw Error('Invalid call reservation');
  const { id } = value.session;
  const { legId, mediaPath, mediaToken } = value.browserLeg;
  if (!matches(id, sessionIdPattern) || !matches(legId, legIdPattern) || typeof mediaPath !== 'string' ||
      !matches(mediaToken, /^[A-Za-z0-9_-]{43}$/)) throw Error('Invalid call reservation');
  const call: OwnedCall = { id, legId, deviceId: intent.deviceId, simId: intent.simId, controls: {} };
  if (readCallState(value.session, call) !== 'awaiting_browser') throw Error('Call no longer awaiting media');
  if (!mediaPath.startsWith('/ws/media?')) throw Error('Invalid media path');
  const params = new URLSearchParams(mediaPath.slice('/ws/media?'.length));
  if ([...params].length !== 2 || params.get('session') !== id || params.get('leg') !== legId || mediaPath.includes('#')) throw Error('Invalid media path');
  return { call, mediaPath, mediaToken };
}

function eligible(device: Device, sim: Sim, now: number) {
  return device.online === true && device.enabled === true && device.paused === false && device.callEnabled === true &&
    matches(sim.id, simIdPattern) && sim.state === 'ready' && typeof sim.lastSeenAt === 'number' && Number.isFinite(sim.lastSeenAt) &&
    sim.lastSeenAt >= 0 && sim.lastSeenAt <= now && now - sim.lastSeenAt <= 2 * 60 * 60 * 1000;
}

export function BrowserDialer() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const session = useSession(state => state.session);
  const [simId, setSimId] = useState('');
  const [to, setTo] = useState('');
  const [digits, setDigits] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>();
  const [owned, setOwned] = useState<OwnedCall | undefined>(() => session ? callRecords.get(session) : undefined);
  const [listening, setListening] = useState(false);
  const [control, setControl] = useState<ControlKind>();
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const controlRef = useRef<ControlAttempt | undefined>(undefined);
  const reviewRef = useRef<ControlTarget | undefined>(undefined);
  const hangupDialog = useRef<HTMLDialogElement>(null);
  const cancelHangup = useRef<HTMLButtonElement>(null);
  const hangupTitle = useId();
  const hangupHelp = useId();
  const recovery = session && unresolved.get(session);
  const canUseAudio = microphoneAvailable();

  const availability = useQuery({ queryKey: availabilityKey, queryFn: ({ signal }) => readAvailable(signal), enabled: !!session, staleTime: 0, retry: false, refetchInterval: 10_000 });
  const deviceIds = availability.isSuccess ? availability.data : [];
  const devices = useInfiniteQuery({
    queryKey: ['devices', 'browser-call-options'], queryFn: ({ pageParam, signal }) => api.devices(pageParam, signal),
    initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined,
    enabled: !!session && deviceIds.length > 0, retry: false,
  });
  const choices = (devices.isSuccess ? devices.data.pages : []).flatMap(page => Array.isArray(page.data) ? page.data : []).flatMap(device =>
    deviceIds.includes(device.id) && Array.isArray(device.sims) ? device.sims.filter(sim => eligible(device, sim, Date.now())).map(sim => ({ device, sim })) : []);
  const selection = choices.find(choice => choice.sim.id === simId);
  const currentOwned = !!session && !!owned && callRecords.get(session) === owned;
  const summaryKey = ['calls', owned?.id, 'browser-control'] as const;
  const summary = useQuery({
    queryKey: summaryKey, enabled: currentOwned,
    queryFn: async ({ signal }) => {
      if (!owned || !session || activeSession() !== session || callRecords.get(session) !== owned) throw Error('No current call selected');
      const result = await request<unknown>('/api/calls/' + encodeURIComponent(owned.id) + '/summary', { signal, cache: 'no-store' });
      if (activeSession() !== session || callRecords.get(session) !== owned) throw Error('Call observation superseded');
      return readCallState(result.data, owned);
    },
    staleTime: 0, refetchInterval: query => query.state.data === 'ended' || query.state.data === 'unknown' ? false : 2_000, retry: false,
  });
  const callState = summary.data;
  const terminal = summary.isSuccess && (callState === 'ended' || callState === 'unknown');

  useEffect(() => {
    function release() {
      const attempt = attemptRef.current;
      attemptRef.current = undefined;
      reviewRef.current = undefined;
      if (hangupDialog.current?.open) hangupDialog.current.close();
      abandonControl(controlRef);
      releaseAudio(attempt);
    }
    function pageHidden() {
      release();
      setListening(false); setBusy(false); setControl(undefined); setNotice(undefined);
    }
    const unsubscribe = useSession.subscribe((next, previous) => {
      if (next.session === previous.session) return;
      release();
      if (previous.session) { unresolved.delete(previous.session); callRecords.delete(previous.session); }
      setOwned(undefined); setListening(false); setBusy(false); setControl(undefined); setNotice(undefined);
      setTo(''); setSimId(''); setDigits('');
    });
    window.addEventListener('pagehide', pageHidden);
    return () => { unsubscribe(); window.removeEventListener('pagehide', pageHidden); release(); };
  }, []);

  useEffect(() => {
    if (summary.isSuccess && callState !== 'awaiting_browser') clearTimeout(attemptRef.current?.mediaTimer);
    if (!terminal) return;
    const attempt = attemptRef.current;
    attemptRef.current = undefined;
    reviewRef.current = undefined;
    if (hangupDialog.current?.open) hangupDialog.current.close();
    abandonControl(controlRef);
    releaseAudio(attempt);
    setListening(false); setControl(undefined);
  }, [terminal, callState, summary.isSuccess]);

  async function dial(intent: Intent, retry: boolean) {
    const actor = activeSession();
    if (!actor || session !== actor || attemptRef.current || callRecords.has(actor) || !canUseAudio || !deviceIds.includes(intent.deviceId)) return;
    const previous = unresolved.get(actor);
    if (retry ? previous !== intent : !!previous) return;
    const controller = new AbortController();
    const attempt: Attempt = { owner: actor, controller, sent: false };
    const owns = () => attemptRef.current === attempt && useSession.getState().session === actor && actor.expiresAt > Date.now();
    attemptRef.current = attempt;
    setBusy(true); setNotice('preparing'); setOwned(undefined); setListening(false);
    setDigits('');
    let timeout = setTimeout(() => controller.abort(), 30_000);
    let reservationReceived = false;
    try {
      const prepared = await prepareCallAudio(controller.signal);
      if (!owns()) { prepared.close(); return; }
      attempt.prepared = prepared;
      controller.signal.throwIfAborted();
      clearTimeout(timeout);
      timeout = setTimeout(() => controller.abort(), 12_000);
      // Permission prompts may take a long time, so check the existing authoritative list again.
      const freshDevices = await readAvailable(controller.signal);
      if (!owns()) return;
      controller.signal.throwIfAborted();
      if (!freshDevices.includes(intent.deviceId)) {
        setNotice('unavailable');
        void client.invalidateQueries({ queryKey: availabilityKey, exact: true });
        return;
      }
      if (!prepared.usable()) { setNotice('audioFailed'); return; }
      unresolved.set(actor, intent);
      attempt.sent = true;
      setNotice('reserving');
      const response = await request<unknown>('/api/calls', { method: 'POST', body: { simId: intent.simId, to: intent.to }, idempotencyKey: intent.key, signal: controller.signal });
      if (!owns()) return;
      controller.signal.throwIfAborted();
      const { call, mediaPath, mediaToken } = reservation(response.data, intent);
      reservationReceived = true;
      unresolved.delete(actor);
      callRecords.set(actor, call);
      setOwned(call);
      function onAudioClosed() {
        if (!owns() || attempt.prepared !== prepared) return;
        releaseAudio(attempt);
        setListening(false);
      }
      prepared.attach(mediaPath, mediaToken, { onFlags: () => {}, onClosed: onAudioClosed });
      const usable = attempt.prepared === prepared && prepared.usable();
      if (usable) attempt.mediaTimer = setTimeout(onAudioClosed, 12_000);
      setListening(usable);
      setNotice(undefined);
      void client.invalidateQueries({ queryKey: ['calls'] });
    } catch (cause) {
      if (!owns()) return;
      if (reservationReceived) { releaseAudio(attempt); setListening(false); setNotice(undefined); }
      else if (attempt.sent && !retry && rejected(cause)) { unresolved.delete(actor); setNotice('rejected'); }
      else if (attempt.sent) setNotice('reservationUnknown');
      else setNotice(attempt.prepared ? 'unavailable' : 'audioFailed');
    } finally {
      clearTimeout(timeout);
      if (owns()) {
        if (!reservationReceived || !attempt.prepared?.usable()) {
          releaseAudio(attempt);
          if (!reservationReceived) attemptRef.current = undefined;
        }
        setBusy(false);
      }
    }
  }

  const recentSummary = summary.isSuccess && summary.isFetchedAfterMount && fresh(summary.dataUpdatedAt);
  const mayControl = currentOwned && recentSummary && !terminal && !control && !busy && !owned?.controls.hangup && owned?.controls.dtmf !== 'pending';
  const hangupAvailable = mayControl && canHangup(callState);
  const dtmfAvailable = mayControl && listening && callState === 'bridged' && !owned?.controls.dtmf;

  async function sendControl(kind: ControlKind, target: ControlTarget, entered?: string) {
    const { owner, call } = target;
    const audio = attemptRef.current;
    if (busy || activeSession() !== owner || callRecords.get(owner) !== call || controlRef.current ||
        call.controls.hangup || call.controls.dtmf === 'pending') return;
    const snapshot = client.getQueryState<CallState>(['calls', call.id, 'browser-control']);
    if (!summary.isFetchedAfterMount || snapshot?.status !== 'success' || snapshot.isInvalidated || !fresh(snapshot.dataUpdatedAt)) {
      setNotice('summaryStale');
      void summary.refetch();
      return;
    }
    if (kind === 'dtmf') {
      if (snapshot.data !== 'bridged' || !listening || audio?.owner !== owner || !audio.prepared?.usable() ||
          call.controls.dtmf || !entered || !/^[0-9*#]{1,32}$/.test(entered)) return;
    } else if (!canHangup(snapshot.data)) return;

    const controller = new AbortController();
    const attempt: ControlAttempt = { ...target, kind, controller };
    const owns = () => controlRef.current === attempt && activeSession() === owner && callRecords.get(owner) === call;
    const readBack = () => { void client.invalidateQueries({ queryKey: ['calls'] }); };
    controlRef.current = attempt;
    // Lock before invoking fetch. Navigation or timeout may lose the response,
    // but cannot prove that Core did not act on the request.
    call.controls[kind] = 'pending';
    setControl(kind); setNotice(undefined);
    if (kind === 'dtmf') setDigits('');
    attempt.timer = setTimeout(() => {
      if (!owns()) return;
      abandonControl(controlRef);
      setControl(undefined);
      readBack();
    }, 12_000);
    try {
      const response = await request<unknown>('/api/calls/' + encodeURIComponent(call.id) + '/' + kind, {
        method: 'POST', ...(kind === 'dtmf' ? { body: { digits: entered } } : {}), signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!record(response.data) || Object.keys(response.data).length !== 0) throw Error('Invalid acknowledgement');
      if (owns()) {
        call.controls[kind] = kind === 'hangup' ? 'accepted' : undefined;
        if (kind === 'dtmf') setNotice('dtmfSent');
      }
    } catch (cause) {
      if (owns()) {
        if (rejected(cause)) { call.controls[kind] = undefined; setNotice('controlRejected'); }
        else call.controls[kind] = 'unknown';
      }
    } finally {
      clearTimeout(attempt.timer);
      if (owns()) {
        controlRef.current = undefined;
        setControl(undefined);
        readBack();
      }
    }
  }

  function reviewHangup() {
    if (!hangupAvailable || !session || !owned || callRecords.get(session) !== owned || activeSession() !== session) return;
    const modal = hangupDialog.current;
    if (!modal || modal.open) return;
    reviewRef.current = { owner: session, call: owned };
    modal.showModal();
    cancelHangup.current?.focus();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !selection || !to.trim() || to.trim().length > 64) return;
    void dial({ key: newIdempotencyKey(), simId: selection.sim.id, deviceId: selection.device.id, to: to.trim() }, false);
  }
  const recordedControl = owned?.controls.hangup === 'unknown' ? 'hangupUnknown' :
    owned?.controls.hangup === 'accepted' && !terminal ? 'hangupSent' : owned?.controls.dtmf === 'unknown' ? 'dtmfUnknown' : undefined;
  const shownNotice = notice ?? (recovery ? 'reservationUnknown' : undefined);
  const canChoose = !!session && availability.isSuccess && deviceIds.length > 0 && canUseAudio;

  return <section className="panel" aria-label={t('browserCall.title')}>
    <h2>{t('browserCall.title')}</h2>
    {!owned && <>
      {availability.isFetching && !availability.data ? <p role="status">{t('loading')}</p> : !canChoose && <p>{t(!canUseAudio && deviceIds.length ? 'browserCall.audioRequired' : 'action.audioUnavailable')}</p>}
      {session && !busy && !deviceIds.length && <button type="button" className="secondary" onClick={() => { void availability.refetch(); }}>{t('browserCall.refresh')}</button>}
      {canChoose && !recovery && <form onSubmit={submit}>
        <p>{t('browserCall.notice')}</p>
        <label className="field">{t('browserCall.sim')}<select value={selection?.sim.id ?? ''} required disabled={busy || !choices.length} onChange={event => setSimId(event.target.value)}>
          <option value="">{t('compose.choose')}</option>{choices.map(({ device, sim }) => <option key={sim.id} value={sim.id}>{device.name} · {t('device.slot')} {sim.slot + 1}</option>)}
        </select></label>
        {!devices.isPending && !choices.length && <p>{t('browserCall.noSims')}</p>}
        {devices.isError && <button type="button" className="secondary" onClick={() => { void devices.refetch(); }}>{t('browserCall.refresh')}</button>}
        {devices.hasNextPage && <button type="button" className="secondary" disabled={busy || devices.isFetching} onClick={() => { void devices.fetchNextPage(); }}>{t('loadMore')}</button>}
        <label className="field">{t('browserCall.destination')}<input type="tel" autoComplete="off" required maxLength={64} value={to} disabled={busy} onChange={event => setTo(event.target.value)}/></label>
        <button className="secondary" disabled={busy || !selection || !to.trim()}>{t('browserCall.dial')}</button>
      </form>}
      {busy && !attemptRef.current?.sent && <button type="button" className="secondary" onClick={() => attemptRef.current?.controller.abort()}>{t('action.close')}</button>}
      {recovery && !busy && <><p>{t('browserCall.destination')}: <bdi>{recovery.to}</bdi></p><p>{t('browserCall.resumeNotice')}</p><button type="button" className="secondary" disabled={!canChoose || !deviceIds.includes(recovery.deviceId)} onClick={() => { void dial(recovery, true); }}>{t('browserCall.resume')}</button></>}
    </>}
    {owned && <>
      <p role="status">{t('browserCall.observed')}: {t(callState && !summary.isError ? 'browserCall.states.' + callState : 'unknown')}</p>
      {summary.isError && <p role="alert">{t('browserCall.summaryUnavailable')}</p>}
      <button type="button" className="secondary" disabled={!currentOwned || summary.isFetching} onClick={() => { void summary.refetch(); }}>{t('browserCall.refreshStatus')}</button>{' '}
      <button type="button" className="secondary danger" aria-haspopup="dialog" disabled={!hangupAvailable} onClick={reviewHangup}>{t('action.hangup')}</button>
      <dialog ref={hangupDialog} aria-labelledby={hangupTitle} aria-describedby={hangupHelp}
        onCancel={() => { reviewRef.current = undefined; }}
        onClose={event => { if (!event.currentTarget.open) reviewRef.current = undefined; }}>
        <h3 id={hangupTitle}>{t('browserCall.confirmHangupTitle')}</h3>
        <p id={hangupHelp}>{t('browserCall.confirmHangupHelp')}</p>
        <p>{t('browserCall.observed')}: <bdi>{t(callState && recentSummary ? 'browserCall.states.' + callState : 'unknown')}</bdi></p>
        <button ref={cancelHangup} type="button" className="secondary" onClick={() => {
          reviewRef.current = undefined;
          hangupDialog.current?.close();
        }}>{t('action.close')}</button>{' '}
        <button type="button" className="secondary danger" disabled={!hangupAvailable} onClick={() => {
          if (!hangupDialog.current?.open) return;
          const target = reviewRef.current;
          reviewRef.current = undefined;
          hangupDialog.current?.close();
          if (target) void sendControl('hangup', target);
        }}>{t('browserCall.confirmHangup')}</button>
      </dialog>
      <form onSubmit={event => { event.preventDefault(); if (session && owned) void sendControl('dtmf', { owner: session, call: owned }, digits); }}>
        <label className="field">{t('browserCall.digits')}<input required value={digits} maxLength={32} inputMode="tel" pattern="[0-9*#]+" disabled={!dtmfAvailable} onChange={event => setDigits(event.target.value)}/></label>
        <button className="secondary" disabled={!dtmfAvailable || !/^[0-9*#]{1,32}$/.test(digits)}>{t('browserCall.sendDtmf')}</button>
      </form>
      {listening && <button type="button" className="secondary" onClick={() => {
        releaseAudio(attemptRef.current); setListening(false);
      }}>{t('browserCall.disconnect')}</button>}
      {!listening && !terminal && !busy && <p role="status">{t('browserCall.audioLost')}</p>}
      {control && <p role="status">{t('loading')}</p>}
      {terminal && <button type="button" className="secondary" onClick={() => {
        if (session && callRecords.get(session) === owned) callRecords.delete(session);
        setOwned(undefined); setNotice(undefined); setTo('');
      }}>{t('browserCall.back')}</button>}
    </>}
    {recordedControl && <p role={recordedControl === 'hangupSent' ? 'status' : 'alert'}>{t('browserCall.' + recordedControl)}</p>}
    {shownNotice && <p role={['audioFailed', 'unavailable', 'rejected', 'reservationUnknown', 'controlRejected'].includes(shownNotice) ? 'alert' : 'status'}>{t('browserCall.' + shownNotice)}</p>}
  </section>;
}
