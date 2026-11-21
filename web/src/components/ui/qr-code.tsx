import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useTranslation } from 'react-i18next';
export function QrCode({value}:{value:string}){const {t}=useTranslation();const [src,setSrc]=useState('');useEffect(()=>{let active=true;setSrc('');void QRCode.toDataURL(value,{margin:2,width:220}).then(data=>{if(active)setSrc(data);}).catch(()=>{if(active)setSrc('');});return ()=>{active=false;};},[value]);return src?<img src={src} alt={t('countdown.bindingQr')}/>:<p>{t('action.qrUnavailable')}</p>;}
