import type { FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { MoreSettings } from './more-settings';
import { AccountSettings } from './account-settings';
import { addSetting, fetchSettings, identity, numberInput, settingsKey, useSettingDraft, useSettingsWriter, type ConditionalPatch, type Settings } from './settings-refresh';
import { SettingsWriteFeedback } from './settings-write-feedback';

export function Form({ settings }: { settings: Settings }) {
  const { t } = useTranslation();
  const writer = useSettingsWriter();
  const { blocked } = writer;
  const forward = useSettingDraft(settings.smsForward, identity, identity, blocked, writer.restore('smsForward'));
  const rate = useSettingDraft(settings.smsRatePerMin, value => value?.toString() ?? '', value => value === '' ? null : numberInput(value), blocked, writer.restore('smsRatePerMin'));
  const heartbeat = useSettingDraft(settings.heartbeatSec, String, value => numberInput(value, 1, 86400), blocked, writer.restore('heartbeatSec'));
  const offline = useSettingDraft(settings.offlineAfterSec, String, numberInput, blocked, writer.restore('offlineAfterSec'));
  const locale = useSettingDraft(settings.botLocale, identity, identity, blocked, writer.restore('botLocale'));
  function conflict(field: { conflict: boolean; latest: () => void; keep: () => void }, label: string) {
    return field.conflict && <div role="alert"><p>{t('settingsPage.draftConflict', { field: label })}</p><button type="button" disabled={blocked} onClick={field.latest}>{t('settingsPage.useLatest')}</button><button type="button" disabled={blocked} onClick={field.keep}>{t('settingsPage.keepMine')}</button></div>;
  }
  function save(event: FormEvent, patch: ConditionalPatch, invalid: boolean) {
    event.preventDefault();
    if (!blocked && !invalid) void writer.save('basic', patch);
  }
  const sms: ConditionalPatch = { changes: {}, expected: {} };
  addSetting(sms, 'smsForward', forward);
  addSetting(sms, 'smsRatePerMin', rate);
  const timing: ConditionalPatch = { changes: {}, expected: {} };
  addSetting(timing, 'heartbeatSec', heartbeat);
  addSetting(timing, 'offlineAfterSec', offline);
  const bot: ConditionalPatch = { changes: {}, expected: {} };
  addSetting(bot, 'botLocale', locale);
  const smsInvalid = forward.conflict || rate.conflict || rate.parsed === undefined;
  const timingInvalid = heartbeat.conflict || offline.conflict || heartbeat.parsed === undefined || offline.parsed === undefined;
  return <>
    <form className="panel" onSubmit={event => save(event, sms, smsInvalid)}><h2>{t('settingsPage.sms')}</h2>
      <label><input type="checkbox" checked={forward.value} disabled={blocked} onChange={event => forward.set(event.target.checked)}/> {t('settingsPage.forward')}</label>{conflict(forward, t('settingsPage.forward'))}
      <label className="field">{t('settingsPage.rate')}<input type="number" min="1" value={rate.value} disabled={blocked} onChange={event => rate.set(event.target.value)}/></label>{conflict(rate, t('settingsPage.rate'))}
      <button className="secondary" disabled={blocked || smsInvalid || !Object.keys(sms.changes).length}>{t('action.save')}</button>
    </form>
    <form className="panel" onSubmit={event => save(event, timing, timingInvalid)}><h2>{t('settingsPage.timing')}</h2>
      <label className="field">{t('settingsPage.heartbeat')}<input type="number" min="1" max="86400" required value={heartbeat.value} disabled={blocked} onChange={event => heartbeat.set(event.target.value)}/></label>{conflict(heartbeat, t('settingsPage.heartbeat'))}
      <label className="field">{t('settingsPage.offline')}<input type="number" min="1" required value={offline.value} disabled={blocked} onChange={event => offline.set(event.target.value)}/></label>{conflict(offline, t('settingsPage.offline'))}
      <button className="secondary" disabled={blocked || timingInvalid || !Object.keys(timing.changes).length}>{t('action.save')}</button>
    </form>
    <form className="panel" onSubmit={event => save(event, bot, locale.conflict)}><h2>{t('settingsPage.bot')}</h2>
      <label className="field">{t('settingsPage.botLocale')}<select value={locale.value} disabled={blocked} onChange={event => locale.set(event.target.value as Settings['botLocale'])}><option value="zh-CN">简体中文</option><option value="zh-HK">繁體中文</option><option value="en">English</option></select></label>{conflict(locale, t('settingsPage.botLocale'))}
      <button className="secondary" disabled={blocked || locale.conflict || !locale.dirty}>{t('action.save')}</button>
    </form>
    <SettingsWriteFeedback writer={writer} group="basic"/>
  </>;
}

export function SettingsPage() {
  const { t } = useTranslation();
  const query = useQuery({ queryKey: settingsKey, queryFn: ({ signal }) => fetchSettings(signal), retry: false });
  return <><h1>{t('settings')}</h1>{query.data ? <>
    {query.isError && <p role="alert">{t('settingsPage.refreshFailed')}</p>}
    <Form settings={query.data.data}/><MoreSettings settings={query.data.data}/><AccountSettings/>
  </> : query.isPending ? <p role="status">{t('loading')}</p> : <p role="alert">{t('loadError')}</p>}</>;
}
