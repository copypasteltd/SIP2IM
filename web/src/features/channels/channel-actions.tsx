import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ApiError, request } from '../../api/client';
import type { Channel } from '../../api/management';
import { canReadLoginStep, parseLoginStep, useLoginSteps, type LoginOperation, type LoginStep } from '../../realtime/login-steps';
import { useConnection } from '../../realtime/use-admin-socket';
import { activeSession, useSession } from '../../stores/session';
import { ErrorMessage } from '../../components/ui/error-message';

type StepRead = { controller: AbortController; timer?: ReturnType<typeof setTimeout> };
function retireRead(ref: { current: StepRead | undefined }) {
  const attempt = ref.current;
  ref.current = undefined;
  if (!attempt) return;
  clearTimeout(attempt.timer);
  attempt.controller.abort();
}

export function ChannelActions({ channel, reading = false }: { channel: Channel; reading?: boolean }) {
  const { t } = useTranslation();
  const client = useQueryClient();
  const platform = channel.platform;
  const path = '/api/channels/' + platform;
  const step = useLoginSteps(s => s.steps[platform]);
  const progress = useLoginSteps(s => s.progress[platform]);
  const connected = useConnection(s => s.state === 'connected');
  const session = useSession(s => s.session);
  const [input, setInput] = useState<{ step: LoginStep; value: string }>();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(undefined);
  const inFlight = useRef(false);
  const readRef = useRef<StepRead | undefined>(undefined);
  const [readingStep, setReadingStep] = useState(false);
  const [readFailed, setReadFailed] = useState(false);
  const value = input && input.step === step && connected ? input.value : '';
  const login = channel.capabilities?.login === true;
  const phase = progress?.phase;
  const missedPrompt = phase === 'missed' || (!step && !phase && channel.state === 'login_pending');
  const canRecover = !!session && connected && login && canReadLoginStep(progress) && (Boolean(step) || missedPrompt || phase === 'waiting');
  const startDisabled = pending || reading || readingStep || !session || !login || !connected || Boolean(step) || phase === 'waiting' || phase === 'uncertain' || Boolean(progress?.operation) || channel.state !== 'logged_out';
  useEffect(() => {
    setInput(undefined);
    if (step) { setReadFailed(false); setError(undefined); }
  }, [step, connected, session, platform]);
  useEffect(() => {
    setReadingStep(false); setReadFailed(false);
    const unsubscribe = useConnection.subscribe((next, previous) => {
      if (next.state === previous.state || next.state === 'connected') return;
      retireRead(readRef);
      setInput(undefined); setReadingStep(false); setReadFailed(false);
    });
    return () => { unsubscribe(); retireRead(readRef); };
  }, [session, platform, login]);

  async function readStep() {
    const owner = activeSession();
    const store = useLoginSteps.getState();
    if (!owner || owner !== session || !canRecover || !login || useConnection.getState().state !== 'connected' ||
        inFlight.current || readRef.current || !canReadLoginStep(store.progress[platform])) return;
    const expected = store.versions[platform];
    const controller = new AbortController();
    const attempt: StepRead = { controller };
    readRef.current = attempt;
    const ownsRead = () => readRef.current === attempt && !controller.signal.aborted && activeSession() === owner &&
      useConnection.getState().state === 'connected';
    const unavailable = () => {
      if (ownsRead() && useLoginSteps.getState().restoreStep(platform, expected, null)) setReadFailed(true);
    };
    setInput(undefined); setError(undefined); setReadFailed(false); setReadingStep(true);
    attempt.timer = setTimeout(() => {
      if (readRef.current !== attempt) return;
      unavailable();
      retireRead(readRef);
      setReadingStep(false);
    }, 10_000);
    try {
      const result = await request<unknown>(path + '/login/step', { signal: controller.signal, cache: 'no-store' });
      if (!ownsRead()) return;
      const current = result.data === null ? null : parseLoginStep(result.data);
      if (current === undefined) { unavailable(); return; }
      useLoginSteps.getState().restoreStep(platform, expected, current);
    } catch { unavailable(); }
    finally {
      if (readRef.current === attempt) {
        clearTimeout(attempt.timer);
        readRef.current = undefined;
        setReadingStep(false);
      }
    }
  }

  async function run(kind: 'start' | 'submit' | 'logout' | 'unpair', submitted?: { step: LoginStep; value: string }) {
    const owner = activeSession();
    if (!owner || owner !== session || inFlight.current || readRef.current) return;
    const store = useLoginSteps.getState();
    const currentStep = store.steps[platform];
    const currentProgress = store.progress[platform];
    if (kind !== 'unpair' && (!login || useConnection.getState().state !== 'connected')) return;
    if (kind === 'start' && (startDisabled || currentStep || currentProgress?.operation || currentProgress?.phase === 'uncertain')) return;
    if (kind === 'logout' && (currentProgress?.operation || currentProgress?.phase === 'uncertain')) return;
    if (kind === 'submit' && (!submitted || currentStep !== submitted.step || currentProgress !== undefined)) return;
    const version = useSession.getState().version;
    const ownsSession = () => useSession.getState().version === version && activeSession() === owner;
    const operation: LoginOperation | undefined = kind === 'unpair' ? undefined : { kind };
    if (operation) store.begin(platform, operation);
    inFlight.current = true;
    setPending(true);
    setError(undefined); setReadFailed(false);
    try {
      if (kind === 'start') await request(path + '/login', { method: 'POST' });
      else if (kind === 'submit' && submitted) await request(path + '/login/submit', { method: 'POST', body: { step: submitted.step.step, challengeId: submitted.step.challengeId, value: submitted.value } });
      else if (kind === 'logout') await request(path + '/logout', { method: 'POST' });
      else if (kind === 'unpair') await request(path + '/paired-user', { method: 'DELETE' });
      if (!ownsSession()) return;
      if (operation) useLoginSteps.getState().accept(platform, operation);
      void client.invalidateQueries({ queryKey: ['channels'] });
    } catch (cause) {
      if (!ownsSession()) return;
      const uncertain = !(cause instanceof ApiError) || cause.code === 'TIMEOUT_UNKNOWN' || cause.code === 'INVALID_RESPONSE' || cause.status >= 500;
      if (operation) useLoginSteps.getState().reject(platform, operation, uncertain);
      setError(cause);
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (pending || readingStep || !login || !connected || phase || !step || step.step === 'qr' || !value.trim() || value.length > 4096) return;
    setInput(undefined);
    void run('submit', { step, value });
  }

  return <>
    <div className="action-row">
      <button type="button" className="secondary" disabled={startDisabled} onClick={() => { void run('start'); }}>{t('channelAction.login')}</button>
      <button type="button" className="secondary" disabled>{t('channelAction.pair')}</button>
      <button type="button" className="secondary danger" disabled={!session || pending || readingStep || !login || !connected || Boolean(progress?.operation) || phase === 'uncertain'} onClick={() => { if (window.confirm(t('channelAction.confirmLogout'))) void run('logout'); }}>{t('channelAction.logout')}</button>
      {channel.pairedUser && <button type="button" className="secondary danger" disabled={pending} onClick={() => { if (window.confirm(t('channelAction.confirmUnpair'))) void run('unpair'); }}>{t('channelAction.unpair')}</button>}
      <button type="button" className="secondary danger" disabled>{t(channel.voiceVerified ? 'channelAction.unverify' : 'channelAction.verify')}</button>
    </div>
    {!login && <p>{t('channelAction.loginUnavailable')}</p>}
    {login && !connected && <p role="status">{t('channelAction.socketRequired')}</p>}
    <p>{t('channelAction.pairVoiceUnavailable')}</p>
    {phase === 'uncertain' ? <p role="alert" className="form-error">{t('channelAction.submitUnknown')}</p> : <ErrorMessage error={error}/>}
    {missedPrompt && <p role="status">{t('channelAction.loginRecovery')}</p>}
    {phase === 'waiting' && <p role="status">{t('channelAction.waitingStep')}</p>}
    {canRecover && <button type="button" className="secondary" disabled={pending || readingStep} onClick={() => { void readStep(); }}>{t('channelAction.readStep')}</button>}
    {readingStep && <p role="status">{t('channelAction.readingStep')}</p>}
    {readFailed && <p role="alert">{t('channelAction.readStepFailed')}</p>}
    {login && connected && step && <section>
      <h3>{t('channelAction.step.' + step.step)}</h3>
      {step.hint && <p>{step.hint}</p>}
      {step.step === 'qr' && !phase && step.qrPngBase64 && /^[A-Za-z0-9+/=]+$/.test(step.qrPngBase64) && <img alt={t('channelAction.qr')} src={'data:image/png;base64,' + step.qrPngBase64}/>}
      {step.step !== 'qr' && <form onSubmit={submit}>
        <label className="field">{t('channelAction.step.' + step.step)}<input required type={step.step === 'password' ? 'password' : 'text'} value={value} maxLength={4096} disabled={pending || readingStep || !!phase} onChange={event => setInput({ step, value: event.target.value })} autoComplete="off"/></label>
        <button className="secondary" disabled={pending || readingStep || !!phase}>{t('channelAction.submit')}</button>
      </form>}
    </section>}
  </>;
}
