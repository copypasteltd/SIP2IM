import { useEffect, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import i18n from '../i18n';
import { activeSession, useSession } from '../stores/session';
import { RealtimeConnection, useConnection } from '../realtime/use-admin-socket';
import { useLoginSteps } from '../realtime/login-steps';

const newClient = () => new QueryClient({ defaultOptions: { queries: { staleTime: 30_000, retry: false } } });
let queryClient = newClient();
useSession.subscribe((next, previous) => {
  if (next.version === previous.version) return;
  const retiring = queryClient;
  queryClient = newClient();
  retiring.clear();
  useLoginSteps.getState().clearAll();
  useConnection.getState().setState('disconnected');
});

function SessionExpiry() {
  const session = useSession(state => state.session);
  useEffect(() => {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function check() {
      if (timer !== undefined) clearTimeout(timer);
      // Recheck on foregrounding as browsers can throttle timers in hidden tabs.
      if (activeSession() === session && session) {
        timer = setTimeout(check, Math.min(2_147_483_647, Math.max(1, session.expiresAt - Date.now())));
      }
    }
    check();
    document.addEventListener('visibilitychange', check);
    return () => { if (timer !== undefined) clearTimeout(timer); document.removeEventListener('visibilitychange', check); };
  }, [session]);
  return null;
}

export function AppProviders({ children }: { children: ReactNode }) {
  const version = useSession(state => state.version);
  return <I18nextProvider i18n={i18n}><QueryClientProvider key={version} client={queryClient}>
    <SessionExpiry/><RealtimeConnection/>{children}
  </QueryClientProvider></I18nextProvider>;
}
