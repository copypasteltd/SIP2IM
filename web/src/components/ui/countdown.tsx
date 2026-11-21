import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
export function Countdown({expiresAt}:{expiresAt:number}){const {t}=useTranslation();const [now,setNow]=useState(Date.now());useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return ()=>clearInterval(timer);},[expiresAt]);const seconds=Math.max(0,Math.ceil((expiresAt-now)/1000));return <span>{seconds?t('countdown.remaining',{seconds}):t('countdown.expired')}</span>;}
