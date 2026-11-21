import { ApiError, request, type Page } from './client';

export type AlertState = 'open' | 'acked' | 'resolved';
export type Alert = {
  id: string;
  type: string;
  subjectId: string;
  severity: string;
  state: AlertState;
  lastAt: number;
  detail?: unknown;
};

export const alertsKey = ['alerts'] as const;
export const alertReadbackMs = 30_000;

export async function readAlerts({ limit, state, cursor, signal }: {
  limit: number;
  state?: AlertState;
  cursor?: string | null;
  signal?: AbortSignal;
}): Promise<Page<Alert>> {
  const params = new URLSearchParams({ limit: String(limit) });
  if (state) params.set('state', state);
  if (cursor !== undefined && cursor !== null) params.set('cursor', cursor);
  const page = await request<Alert[]>('/api/alerts?' + params, { signal });
  if (!Array.isArray(page.data) || page.data.length > limit ||
      (page.nextCursor != null && (typeof page.nextCursor !== 'string' || page.nextCursor.length === 0))) {
    throw new ApiError('INVALID_RESPONSE', 200);
  }
  return { data: page.data, nextCursor: page.nextCursor ?? null };
}

export function acknowledgeAlert(id: string) {
  return request<Alert>('/api/alerts/' + encodeURIComponent(id) + '/ack', { method: 'POST' });
}
