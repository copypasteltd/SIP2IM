import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { create } from 'zustand';
import { useSession } from '../stores/session';
import { startAdminSocket, type ConnectionState } from './admin-socket';

export const useConnection = create<{ state: ConnectionState; setState: (state: ConnectionState) => void }>(set => ({ state: 'disconnected', setState: state => set({ state }) }));
export function RealtimeConnection() {
  const session = useSession(state => state.session);
  const client = useQueryClient();
  const setState = useConnection(state => state.setState);
  useEffect(() => {
    if (!session || session.expiresAt <= Date.now()) return;
    return startAdminSocket(session.token, client, setState, () => useSession.getState().session === session && session.expiresAt > Date.now());
  }, [session, client, setState]);
  return null;
}
