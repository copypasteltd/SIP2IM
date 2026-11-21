import { useEffect, useRef, useState, type FormEvent } from 'react';
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
type OwnedCall = Pick<Intent, 'deviceId' | 'simId'> & { id: string; legId: string };
type Attempt = {
  owner: Session; controller: AbortController; prepared?: PreparedCallAudio; sent: boolean;
  mediaTimer?: ReturnType<typeof setTimeout>; hangupLocked?: boolean; dtmfLocked?: boolean;
};
type Notice = 'preparing' | 'reserving' | 'audioFailed' | 'unavailable' | 'rejected' | 'reservationUnknown' | 'audioLost' | 'hangupSent' | 'hangupUnknown' | 'dtmfSent' | 'dtmfUnknown' | 'controlRejected';
// Store only a pending HTTP intent in memory. The media token never enters this map or the query cache.
const unresolved = new WeakMap<Session, Intent>();
const callRecords = new WeakMap<Session, OwnedCall>();

function releaseAudio(attempt?: Attempt) {
  if (!attempt) return;
  clearTimeout(attempt.mediaTimer);
  attempt.controller.abort();
  attempt.prepared?.close();
}

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
  const call: OwnedCall = { id, legId, deviceId: intent.deviceId, simId: intent.simId };
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
  const [control, setControl] = useState<'hangup' | 'dtmf'>();
  const [hangupLocked, setHangupLocked] = useState(false);
  const [dtmfLocked, setDtmfLocked] = useState(false);
  const attemptRef = useRef<Attempt | undefined>(undefined);
  const controlRef = useRef<AbortController | undefined>(undefined);
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
  const summaryKey = ['calls', owned?.id, 'browser-control'] as const;
  const summary = useQuery({
    queryKey: summaryKey, enabled: !!session && !!owned,
    queryFn: async ({ signal }) => {
      if (!owned) throw Error('No call selected');
      const result = await request<unknown>('/api/calls/' + encodeURIComponent(owned.id) + '/summary', { signal });
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
      releaseAudio(attempt);
      controlRef.current?.abort();
      controlRef.current = undefined;
    }
    function pageHidden() {
      const attempt = attemptRef.current;
      release();
      if (!attempt) return;
      setListening(false); setBusy(false); setControl(undefined);
      setNotice(unresolved.has(attempt.owner) ? 'reservationUnknown' : attempt.sent ? 'audioLost' : undefined);
    }
    const unsubscribe = useSession.subscribe((next, previous) => {
      if (next.session === previous.session) return;
      if (previous.session) { unresolved.delete(previous.session); callRecords.delete(previous.session); }
      release();
      setOwned(undefined); setListening(false); setBusy(false); setControl(undefined); setNotice(undefined);
      setTo(''); setSimId(''); setDigits(''); setHangupLocked(false); setDtmfLocked(false);
    });
    window.addEventListener('pagehide', pageHidden);
    return () => { unsubscribe(); window.removeEventListener('pagehide', pageHidden); release(); };
  }, []);

  useEffect(() => {
    if (summary.isSuccess && callState !== 'awaiting_browser') clearTimeout(attemptRef.current?.mediaTimer);
    if (!terminal) return;
    const attempt = attemptRef.current;
    attemptRef.current = undefined;
    releaseAudio(attempt);
    controlRef.current?.abort();
    controlRef.current = undefined;
    setListening(false); setControl(undefined);
  }, [terminal, callState, summary.isSuccess]);

  async function dial(intent: Intent, retry: boolean) {
    const actor = activeSession();
    if (!actor || session !== actor || attemptRef.current || !canUseAudio || !deviceIds.includes(intent.deviceId)) return;
    const previous = unresolved.get(actor);
    if (retry ? previous !== intent : !!previous) return;
    const controller = new AbortController();
    const attempt: Attempt = { owner: actor, controller, sent: false };
    const owns = () => attemptRef.current === attempt && useSession.getState().session === actor && actor.expiresAt > Date.now();
    attemptRef.current = attempt;
    setBusy(true); setNotice('preparing'); setOwned(undefined); setListening(false);
    setHangupLocked(false); setDtmfLocked(false); setDigits('');
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
        if (!owns()) return;
        clearTimeout(attempt.mediaTimer);
        setListening(false); setNotice(state => state === 'hangupUnknown' || state === 'hangupSent' ? state : 'audioLost');
      }
      prepared.attach(mediaPath, mediaToken, { onFlags: () => {}, onClosed: onAudioClosed });
      if (prepared.usable()) attempt.mediaTimer = setTimeout(() => { prepared.close(); onAudioClosed(); }, 12_000);
      setListening(prepared.usable());
      setNotice(prepared.usable() ? undefined : 'audioLost');
      void client.invalidateQueries({ queryKey: ['calls'] });
    } catch (cause) {
      if (!owns()) return;
      if (reservationReceived) setNotice('audioLost');
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

  const mayControl = !!owned && !!session && listening && summary.isSuccess && Date.now() - summary.dataUpdatedAt <= 5_000 &&
    !terminal && !control && !busy && !hangupLocked;
  async function sendControl(kind: 'hangup' | 'dtmf', entered?: string) {
    const live = attemptRef.current;
    if (!mayControl || !owned || !session || live?.owner !== session || activeSession() !== session ||
        !live.prepared?.usable() || live.hangupLocked || controlRef.current) return;
    const snapshot = client.getQueryState<CallState>(summaryKey);
    if (snapshot?.status !== 'success' || Date.now() - snapshot.dataUpdatedAt > 5_000) {
      void summary.refetch();
      return;
    }
    if (kind === 'dtmf' ? snapshot.data !== 'bridged' || live.dtmfLocked || dtmfLocked || !entered || !/^[0-9*#]{1,32}$/.test(entered) :
      snapshot.data !== 'awaiting_browser' && snapshot.data !== 'cell_dialing' && snapshot.data !== 'bridged') return;
    const controller = new AbortController();
    controlRef.current = controller;
    setControl(kind); setNotice(undefined);
    if (kind === 'dtmf') setDigits('');
    const timeout = setTimeout(() => controller.abort(), 12_000);
    const owns = () => controlRef.current === controller && attemptRef.current === live && useSession.getState().session === live.owner && live.owner.expiresAt > Date.now();
    try {
      const response = await request<unknown>('/api/calls/' + encodeURIComponent(owned.id) + '/' + kind, {
        method: 'POST', ...(kind === 'dtmf' ? { body: { digits: entered } } : {}), signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      if (!record(response.data) || Object.keys(response.data).length !== 0) throw Error('Invalid acknowledgement');
      if (owns()) {
        setNotice(kind === 'hangup' ? 'hangupSent' : 'dtmfSent');
        if (kind === 'hangup') { live.hangupLocked = true; setHangupLocked(true); }
      }
    } catch (cause) {
      if (!owns()) return;
      if (rejected(cause)) setNotice('controlRejected');
      else if (kind === 'hangup') { live.hangupLocked = true; setHangupLocked(true); setNotice('hangupUnknown'); }
      else { live.dtmfLocked = true; setDtmfLocked(true); setNotice('dtmfUnknown'); }
    } finally {
      clearTimeout(timeout);
      if (owns()) {
        controlRef.current = undefined;
        setControl(undefined);
        void client.invalidateQueries({ queryKey: ['calls'] });
      }
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (busy || !selection || !to.trim() || to.trim().length > 64) return;
    void dial({ key: newIdempotencyKey(), simId: selection.sim.id, deviceId: selection.device.id, to: to.trim() }, false);
  }
  const hangupAvailable = mayControl && (callState === 'awaiting_browser' || callState === 'cell_dialing' || callState === 'bridged');
  const dtmfAvailable = mayControl && callState === 'bridged' && !dtmfLocked;
  const shownNotice = (terminal && notice === 'hangupSent' ? undefined : notice) ?? (recovery ? 'reservationUnknown' : owned && !listening && !terminal && !busy ? 'audioLost' : undefined);
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
      <button type="button" className="secondary danger" disabled={!hangupAvailable} onClick={() => { void sendControl('hangup'); }}>{t('action.hangup')}</button>
      <form onSubmit={event => { event.preventDefault(); void sendControl('dtmf', digits); }}>
        <label className="field">{t('browserCall.digits')}<input required value={digits} maxLength={32} inputMode="tel" pattern="[0-9*#]+" disabled={!dtmfAvailable} onChange={event => setDigits(event.target.value)}/></label>
        <button className="secondary" disabled={!dtmfAvailable || !/^[0-9*#]{1,32}$/.test(digits)}>{t('browserCall.sendDtmf')}</button>
      </form>
      {listening && <button type="button" className="secondary" onClick={() => {
        releaseAudio(attemptRef.current); setListening(false); setNotice('audioLost');
      }}>{t('browserCall.disconnect')}</button>}
      {control && <p role="status">{t('loading')}</p>}
      {terminal && <button type="button" className="secondary" onClick={() => {
        if (session && callRecords.get(session) === owned) callRecords.delete(session);
        setOwned(undefined); setNotice(undefined); setTo('');
      }}>{t('browserCall.back')}</button>}
    </>}
    {shownNotice && <p role={['audioFailed', 'unavailable', 'rejected', 'reservationUnknown', 'audioLost', 'hangupUnknown', 'dtmfUnknown', 'controlRejected'].includes(shownNotice) ? 'alert' : 'status'}>{t('browserCall.' + shownNotice)}</p>}
  </section>;
}
