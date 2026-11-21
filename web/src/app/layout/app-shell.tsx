import { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { NavLink, Outlet } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Status } from '../../components/ui/status';
import { useConnection } from '../../realtime/use-admin-socket';
import { ApiError, request } from '../../api/client';
import { api } from '../../api/endpoints';
import { activeSession, clearSession } from '../../stores/session';

const routes = ['dashboard','devices','sms','calls','channels','commands','alerts','settings','audit'] as const;
const adapters = ['qq', 'telegram'] as const;
type Health = { adapters?: Partial<Record<typeof adapters[number], string>> };

export function AppShell() {
  const { t, i18n } = useTranslation();
  const connection = useConnection(state => state.state);
  const [languageError, setLanguageError] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const logoutInFlight = useRef(false);
  const health = useQuery({ queryKey: ['health'], queryFn: ({ signal }) => request<Health>('/api/health', { auth: false, signal }), refetchInterval: 30_000 });

  async function signOut() {
    const session = activeSession();
    if (!session || logoutInFlight.current) return;
    logoutInFlight.current = true;
    setSigningOut(true);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    let confirmed = false;
    try {
      await api.logout(controller.signal);
      confirmed = true;
    } catch (error) {
      // HTTP 401 means this token is already invalid. Other failures cannot
      // prove server-side revocation, even though we can sign out locally.
      confirmed = error instanceof ApiError && error.status === 401;
    } finally {
      clearTimeout(timeout);
      clearSession(session, confirmed ? undefined : 'logout-unconfirmed');
    }
  }
  return <div className="shell"><a className="skip" href="#main">{t('skip')}</a>
    <aside className="sidebar"><div className="brand"><span className="brand-mark" aria-hidden="true"/><div><strong>{t('brand')}</strong><small>{t('subtitle')}</small></div></div>
      <nav aria-label={t('navigation')}><div className="nav-label">{t('workspace')}</div><div className="nav-list">{routes.map(route => <NavLink className="nav-link" key={route} to={'/' + route}>{t(route)}</NavLink>)}</div></nav>
    </aside>
    <div className="workspace"><header className="status-bar"><div className="status-items">
      {adapters.map(platform => {
        const reported = health.isError ? undefined : health.data?.data?.adapters?.[platform];
        return <span key={platform}>{platform === 'qq' ? 'QQ' : 'Telegram'} <Status semantic={reported === 'online' ? 'ok' : 'unk'}>{t(reported === 'online' ? 'capability.adapterReachable' : reported === 'offline' ? 'capability.adapterNotReachable' : 'capability.adapterNotObserved')}</Status></span>;
      })}
      <span className="connection"><Status semantic={connection === 'connected' ? 'ok' : 'warn'}>{t(connection === 'connected' ? 'connectionEstablished' : connection === 'connecting' ? 'capability.connecting' : 'disconnected')}</Status></span>
    </div><div className="action-row"><label className="language"><span>{t('language')}</span>
      <select value={i18n.language} disabled={signingOut} onChange={event => { const locale = event.target.value; setLanguageError(false); void request('/api/auth/locale', { method: 'PUT', body: { locale } }).then(() => i18n.changeLanguage(locale)).catch(() => setLanguageError(true)); }}>
        <option value="zh-CN">简体中文</option><option value="zh-HK">繁體中文（香港）</option><option value="en">English</option>
      </select>{languageError && <span role="alert">{t('action.failed')}</span>}
    </label><button type="button" className="secondary" disabled={signingOut} onClick={() => { void signOut(); }}>{t(signingOut ? 'auth.signingOut' : 'auth.logout')}</button></div></header>
    <main id="main" tabIndex={-1}><Outlet/></main></div>
  </div>;
}
