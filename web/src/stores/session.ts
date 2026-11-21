import { create } from 'zustand';

const key = 'voip.session';
export type Session = { token: string; expiresAt: number; username: string };
type Notice = 'logout-unconfirmed' | 'password-changed';

function parse(value: string | null): Session | null {
  try {
    const saved: unknown = JSON.parse(value ?? 'null');
    if (saved && typeof saved === 'object' && 'token' in saved && typeof saved.token === 'string' && saved.token &&
        'expiresAt' in saved && typeof saved.expiresAt === 'number' && Number.isFinite(saved.expiresAt) && saved.expiresAt > Date.now() &&
        'username' in saved && typeof saved.username === 'string') return saved as Session;
  } catch { /* An unusable saved credential is not a session. */ }
  return null;
}

function load(discardInvalid = false) {
  try {
    const saved = localStorage.getItem(key);
    const session = parse(saved);
    if (discardInvalid && saved !== null && !session && saved === localStorage.getItem(key)) localStorage.removeItem(key);
    return session;
  } catch { return null; }
}

export const useSession = create<{ session: Session | null; version: number; notice: Notice | null; setSession: (session: Session | null, notice?: Notice) => void }>(set => ({
  session: load(true), version: 0, notice: null,
  setSession: (session, notice) => {
    try {
      if (session) localStorage.setItem(key, JSON.stringify(session));
      else localStorage.removeItem(key);
    } catch { /* The in-memory session still changes if storage is unavailable. */ }
    set(state => ({ session, version: state.session === session ? state.version : state.version + 1, notice: notice ?? null }));
  },
}));

export function clearSession(expected: Session, notice?: Notice) {
  if (useSession.getState().session !== expected) return false;
  const stored = load();
  if (stored && stored.token !== expected.token) {
    // A replacement tab can write before its storage event is delivered here.
    useSession.setState(state => ({ session: stored, version: state.version + 1, notice: null }));
    return false;
  }
  useSession.getState().setSession(null, notice);
  return true;
}

export function activeSession() {
  const session = useSession.getState().session;
  if (!session || session.expiresAt > Date.now()) return session;
  clearSession(session);
  return useSession.getState().session;
}

// Honor credential removal or replacement from other tabs. Read the latest
// stored value rather than applying a possibly queued, older storage event.
window.addEventListener('storage', event => {
  if (event.storageArea !== localStorage || (event.key !== key && event.key !== null)) return;
  const session = load();
  const current = useSession.getState().session;
  if (current?.token !== session?.token || current?.expiresAt !== session?.expiresAt || current?.username !== session?.username) {
    useSession.setState(state => ({ session, version: state.version + 1, notice: null }));
  }
});
