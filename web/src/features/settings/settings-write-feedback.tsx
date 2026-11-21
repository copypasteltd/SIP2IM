import { useTranslation } from 'react-i18next';
import { type SettingsGroup, type useSettingsWriter } from './settings-refresh';

export function SettingsWriteFeedback({ writer, group }: { writer: ReturnType<typeof useSettingsWriter>; group: SettingsGroup }) {
  const { t } = useTranslation();
  const { status } = writer;
  if (status.kind === 'idle' || status.group !== group) return null;
  if (status.kind === 'saving') return <p role="status">{t('loading')}</p>;
  if (status.kind === 'rejected') return <p role="alert">{t(group === 'basic' ? 'settingsPage.saveRejected' : 'moreSettings.writeRejected')}</p>;
  if (status.kind === 'unavailable') return <p role="alert">{t('settingsPage.conditionalUnavailable')}</p>;
  if (status.kind === 'review') return <p role="status">{t('settingsPage.reviewRefreshed')}</p>;
  if (status.kind !== 'recovery') return null;
  const uncertain = status.reason === 'uncertain' || status.reason === 'committed';
  return <div className="notice">
    {uncertain && <p role="alert">{t(status.reason === 'committed'
      ? (group === 'basic' ? 'settingsPage.saveCommittedUncertain' : 'moreSettings.writeCommitted')
      : (group === 'basic' ? 'settingsPage.saveUncertain' : 'moreSettings.writeUncertain'))}</p>}
    {status.read === 'failed' && <p role="alert">{t(status.reason === 'saved' ? 'settingsPage.savedRefreshFailed' : 'settingsPage.conflictRefreshFailed')}</p>}
    {status.read === 'checking' && <p role="status">{t(status.reason === 'conflict' ? 'settingsPage.conflictRefreshPending' : 'loading')}</p>}
    {status.read === 'checked' && uncertain && <p role="status">{t('settingsPage.uncertainExplanation')}</p>}
    {status.read !== 'checking' && <button type="button" className="secondary" onClick={writer.checkCurrent}>{t(status.read === 'failed' ? 'settingsPage.conflictRetryRefresh' : 'settingsPage.refreshSnapshot')}</button>}
    {status.read === 'checked' && uncertain && <button type="button" className="secondary" onClick={writer.acknowledge}>{t('settingsPage.acknowledgeUncertain')}</button>}
  </div>;
}
