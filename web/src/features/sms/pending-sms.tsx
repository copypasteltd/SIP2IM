import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSession } from '../../stores/session';
import { readIntent, subscribeIntent, type SmsIntent } from './send-intent';
import { SendSms } from './send-sms';
export function PendingSms() {
 const {t}=useTranslation(); const username=useSession(s=>s.session?.username ?? ''); const owner=JSON.stringify([username,(import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '']); const [intent,setIntent]=useState<SmsIntent|null>(null); const [error,setError]=useState(false);
 useEffect(()=>{const refresh=()=>{try {setIntent(readIntent());setError(false);} catch {setError(true);}};refresh();return subscribeIntent(refresh);},[]);
 if(error) return <p role="alert">{t('smsSearch.storageError')}</p>;
 if(!intent || intent.owner!==owner) return intent ? <p role="status">{t('smsSearch.otherPending')}</p> : null;
 return <section className="panel"><h2>{t('smsSearch.pendingTitle')}</h2><p>{t('compose.sim')}: {intent.simId}</p><p>{t('compose.recipient')}: {intent.peer}</p><SendSms key={intent.key} simId={intent.simId} peer={intent.peer} recovery/></section>;
}
