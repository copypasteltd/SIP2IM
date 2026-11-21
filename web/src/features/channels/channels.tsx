import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { management } from '../../api/management';
import { ErrorMessage } from '../../components/ui/error-message';
import { Status } from '../../components/ui/status';
import { statusSemantic } from '../../lib/status-map';
import { useConnection } from '../../realtime/use-admin-socket';
import { ChannelActions } from './channel-actions';

export function Channels() {
  const { t } = useTranslation();
  const client = useQueryClient();
  const disconnected = useConnection(s => s.state !== 'connected');
  const query = useQuery({ queryKey: ['channels'], queryFn: ({ signal }) => management.channels(signal) });
  const mutation = useMutation({ mutationFn: management.inbound, retry: false, networkMode: 'always', onSuccess: () => { void client.invalidateQueries({ queryKey: ['channels'] }); } });
  if (query.isPending) return <p role="status">{t('loading')}</p>;
  if (query.isError) return <p role="alert">{t('loadError')}</p>;
  return <><h1>{t('channels')}</h1>
    {disconnected && <p role="status">{t('capability.channelSnapshot')}</p>}
    <fieldset className="panel"><legend>{t('incomingPlatform') }</legend>
      {query.data.data.map(channel => <label className="radio" key={channel.platform}><input type="radio" name="inbound" checked={channel.isInbound} disabled={mutation.isPending} onChange={() => mutation.mutate(channel.platform)}/> {channel.platform === 'qq' ? 'QQ' : 'Telegram'}</label>)}<ErrorMessage error={mutation.error}/>
    </fieldset>
    <div className="dashboard-grid">{query.data.data.map(channel => <section className="panel" key={channel.platform}>
      <h2>{channel.platform === 'qq' ? 'QQ' : 'Telegram'}</h2>
      <p>{t('capability.accountState')}: <Status semantic={statusSemantic('channel', channel.state, disconnected)}>{t('channelState.' + channel.state, { defaultValue: t('unknown') })}</Status></p>
      <p>{t('action.pairedUser')}: {channel.pairedUser?.displayName ?? t('unknown')}</p>
      <p>{t('capability.voiceEvidence')}: {t(channel.voiceVerified === true ? 'capability.voiceRecordMarked' : channel.voiceVerified === false ? 'capability.voiceRecordNotMarked' : 'capability.notObserved')}</p>
      <p>{t('capability.platformOperation')}: {t('capability.platformUnavailable')}</p>
      <ChannelActions channel={channel} reading={query.isFetching}/>
    </section>)}</div>
  </>;
}
