import type { FormEvent } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { addSetting, identity, numberInput, useSettingDraft, useSettingsWriter, type ConditionalPatch, type Settings } from './settings-refresh';
import { SettingsWriteFeedback } from './settings-write-feedback';

const fields = ['inboundRingTimeoutSec', 'outboundUserAnswerTimeoutSec', 'outboundCalleeAnswerTimeoutSec', 'outboundCallbackRingTimeoutSec', 'alertPushIntervalSec', 'earlyMediaThresholdDbfs'] as const;
type More = Pick<Settings, 'defaultDeviceId' | typeof fields[number]>;
function parseThreshold(value: string) {
  return value.trim() !== '' && Number.isFinite(Number(value)) ? Number(value) : undefined;
}

export function MoreSettings({ settings }: { settings: More }) {
  const { t } = useTranslation();
  const writer = useSettingsWriter();
  const { blocked } = writer;
  const device = useSettingDraft(settings.defaultDeviceId, identity, identity, blocked, writer.restore('defaultDeviceId'));
  const drafts = {
    inboundRingTimeoutSec: useSettingDraft(settings.inboundRingTimeoutSec, String, numberInput, blocked, writer.restore('inboundRingTimeoutSec')),
    outboundUserAnswerTimeoutSec: useSettingDraft(settings.outboundUserAnswerTimeoutSec, String, numberInput, blocked, writer.restore('outboundUserAnswerTimeoutSec')),
    outboundCalleeAnswerTimeoutSec: useSettingDraft(settings.outboundCalleeAnswerTimeoutSec, String, numberInput, blocked, writer.restore('outboundCalleeAnswerTimeoutSec')),
    outboundCallbackRingTimeoutSec: useSettingDraft(settings.outboundCallbackRingTimeoutSec, String, numberInput, blocked, writer.restore('outboundCallbackRingTimeoutSec')),
    alertPushIntervalSec: useSettingDraft(settings.alertPushIntervalSec, String, numberInput, blocked, writer.restore('alertPushIntervalSec')),
    earlyMediaThresholdDbfs: useSettingDraft(settings.earlyMediaThresholdDbfs, String, parseThreshold, blocked, writer.restore('earlyMediaThresholdDbfs')),
  };
  const devices = useInfiniteQuery({ queryKey: ['devices'], queryFn: ({ pageParam, signal }) => api.devices(pageParam, signal), initialPageParam: undefined as string | undefined, getNextPageParam: page => page.nextCursor ?? undefined });
  const options = devices.data?.pages.flatMap(p => p.data) ?? [];
  // A set but unloaded device must not be rendered as the null option.
  const displayId = device.value;
  const timing: ConditionalPatch = { changes: {}, expected: {} };
  for (const field of fields) addSetting(timing, field, drafts[field]);
  const timingInvalid = fields.some(field => drafts[field].conflict || drafts[field].parsed === undefined);
  function saveDevice(event: FormEvent) {
    event.preventDefault();
    if (blocked || !devices.isSuccess || device.conflict) return;
    const patch: ConditionalPatch = { changes: {}, expected: {} };
    addSetting(patch, 'defaultDeviceId', device);
    void writer.save('advanced', patch);
  }
  return <>
    <form className="panel" onSubmit={saveDevice}>
      <h2>{t('moreSettings.defaultDevice')}</h2>
      {devices.isError && <p role="alert">{t('loadError')}</p>}
      <label className="field">{t('moreSettings.defaultDevice')}
        <select disabled={blocked || !devices.isSuccess} value={displayId ?? ''} onChange={event => device.set(event.target.value || null)}>
          <option value="">{t('moreSettings.none')}</option>
          {displayId !== null && !options.some(option => option.id === displayId) && <option value={displayId}>{displayId}</option>}
          {options.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
        </select>
      </label>
      {devices.hasNextPage && <button type="button" className="secondary" onClick={() => { void devices.fetchNextPage(); }}>{t('loadMore')}</button>}
      {device.conflict && <div role="alert"><p>{t('moreSettings.deviceConflict')}</p><button type="button" className="secondary" disabled={blocked} onClick={device.latest}>{t('moreSettings.useLatest')}</button><button type="button" className="secondary" disabled={blocked} onClick={device.keep}>{t('moreSettings.keepMine')}</button></div>}
      <button className="secondary" disabled={blocked || !devices.isSuccess || device.conflict || !device.dirty}>{t('action.save')}</button>
    </form>
    <form className="panel" onSubmit={event => { event.preventDefault(); if (!blocked && !timingInvalid) void writer.save('advanced', timing); }}>
      <h2>{t('moreSettings.callTiming')}</h2>
      {fields.map(field => {
        const draft = drafts[field];
        const threshold = field === 'earlyMediaThresholdDbfs';
        return <div key={field}>
          <label className="field">{t('moreSettings.' + field)}<input type="number" step={threshold ? 'any' : undefined} min={threshold ? undefined : 1} required disabled={blocked} value={draft.value} onChange={event => draft.set(event.target.value)}/></label>
          {draft.conflict && <div role="alert"><p>{t('moreSettings.conflict', { value: settings[field] })}</p><button type="button" className="secondary" disabled={blocked} onClick={draft.latest}>{t('moreSettings.useLatest')}</button><button type="button" className="secondary" disabled={blocked} onClick={draft.keep}>{t('moreSettings.keepMine')}</button></div>}
        </div>;
      })}
      <button className="secondary" disabled={blocked || timingInvalid || !Object.keys(timing.changes).length}>{t('action.save')}</button>
    </form>
    <SettingsWriteFeedback writer={writer} group="advanced"/>
  </>;
}
