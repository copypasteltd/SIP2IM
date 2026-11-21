import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { management } from '../../api/management';
import { ErrorMessage } from '../../components/ui/error-message';

export function CallingControl({ deviceId, enabled }: { deviceId: string; enabled: boolean }) {
  const { t, i18n } = useTranslation();
  const client = useQueryClient();
  const [unknown, setUnknown] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  async function reconcile() {
    setUnknown(true);
    setRefreshing(true);
    try {
      const result = await api.device(deviceId);
      client.setQueryData(['devices', deviceId], result);
      void client.invalidateQueries({ queryKey: ['devices'], refetchType: 'none' });
      setUnknown(false);
    } catch {
      // Keep the setting unknown until an authoritative read succeeds.
    } finally {
      setRefreshing(false);
    }
  }
  const mutation = useMutation({
    mutationFn: (next: boolean) => management.updateDevice(deviceId, { callEnabled: next }),
    onSettled: reconcile,
  });
  const explanation = i18n.resolvedLanguage === 'en'
    ? 'This setting controls calling availability in the gateway; it does not add or activate telephony capability on the device.'
    : i18n.resolvedLanguage === 'zh-HK'
      ? '此設定控制網關的通話可用性，並不會為裝置新增或啟用電話通話能力。'
      : '此设置控制网关的通话可用性，不会为设备新增或启用电话通话能力。';
  return <div>
    <p>{explanation}</p>
    {unknown ? <p role="status">{t('device.callEnabled')}: {t('unknown')}</p> :
      <label><input type="checkbox" checked={enabled} disabled={mutation.isPending || refreshing} onChange={event => mutation.mutate(event.target.checked)} /> {t('device.callEnabled')}</label>}
    {(mutation.isPending || refreshing) && <p role="status">{t('loading')}</p>}
    <ErrorMessage error={mutation.error}/>
    {unknown && !refreshing && <><p>{t('dashboardPage.staleHelp')}</p><button type="button" className="secondary" onClick={() => void reconcile()}>{t('records.retry')}</button></>}
  </div>;
}
