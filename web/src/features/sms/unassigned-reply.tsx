import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/endpoints';
import { useConnection } from '../../realtime/use-admin-socket';
import { SendSms } from './send-sms';
export function UnassignedReply({deviceId, peer}: {deviceId:string; peer:string}) {
 const {t}=useTranslation(); const stale=useConnection(s=>s.state!=='connected'); const [simId,setSimId]=useState(''); const [formId,setFormId]=useState(''); const [pending,setPending]=useState(false);
 const device=useQuery({queryKey:['devices','sms-eligibility',deviceId],queryFn:({signal})=>api.device(deviceId,signal)});
 const value=device.data?.data; const sims=useMemo(()=>Array.isArray(value?.sims) && value.enabled && !value.paused ? value.sims.filter(sim=>sim.state==='ready') : [],[value]);
 useEffect(()=>{if(simId && device.isSuccess && !device.isFetching && !sims.some(sim=>sim.id===simId)) setSimId('');},[simId,device.isSuccess,device.isFetching,sims]);
 const chosen=sims.find(sim=>sim.id===simId); const uncertain=stale || chosen?.lastSeenAt==null || !Number.isFinite(chosen.lastSeenAt) || Date.now()-chosen.lastSeenAt>2*60*60*1000;
 return <section><p>{t('smsSearch.unassignedReplyHelp')}</p>{device.isPending?<p role="status">{t('loading')}</p>:!device.data && device.isError?<p role="alert">{t('smsSearch.sendUnavailable')}</p>:<><label className="field">{t('compose.sim')}<select disabled={pending} value={chosen?.id ?? ''} onChange={e=>{setSimId(e.target.value); if(e.target.value) setFormId(e.target.value);}}><option value="">{t('compose.choose')}</option>{sims.map(sim=><option key={sim.id} value={sim.id}>{value?.name} · {t('device.slot')} {sim.slot+1} · {sim.number ?? t('unknown')} · {sim.id}</option>)}</select></label>{!sims.length && <p>{t('smsSearch.sendUnavailable')}</p>}{formId && <>{simId && uncertain && <p role="status">{t('smsSearch.simUncertain')}</p>}<SendSms key={formId+':'+peer} simId={formId} peer={peer} disabled={!chosen || device.isFetching || device.isError} onPendingChange={setPending}/></>}</>}</section>;
}
