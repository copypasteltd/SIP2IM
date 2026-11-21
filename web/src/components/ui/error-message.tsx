import { useTranslation } from 'react-i18next';
import { ApiError } from '../../api/client';
export function ErrorMessage({error}:{error:unknown}) {const {t}=useTranslation();if(!error)return null;const code=error instanceof ApiError && /^[A-Z_]+$/.test(error.code)?error.code:null;return <p role="alert" className="form-error">{t('action.failed')}{code && <> ({code})</>}</p>;}
