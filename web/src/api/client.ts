import { activeSession, clearSession, useSession } from '../stores/session';

export class ApiError extends Error {
  constructor(public code: string, public status: number, public details?: unknown) { super(code); }
}
export type Page<T> = { data: T[]; nextCursor: string | null };
const base = (import.meta.env.VITE_API_BASE as string | undefined)?.replace(/\/$/, '') ?? '';

type RequestOptions = { method?: string; body?: unknown; idempotencyKey?: string; auth?: boolean; signal?: AbortSignal; cache?: RequestCache };
export async function request<T>(path: string, options: RequestOptions = {}): Promise<{ data: T; nextCursor?: string | null }> {
  const previous = useSession.getState().session;
  const session = options.auth === false ? null : activeSession();
  if (options.auth !== false && previous && session !== previous) throw new ApiError('SESSION_CHANGED', 401);
  const version = useSession.getState().version;
  const headers = new Headers();
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (session) headers.set('Authorization', 'Bearer ' + session.token);
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  const response = await fetch(base + path, {
    method: options.method ?? 'GET', headers, signal: options.signal, redirect: 'error',
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    ...(options.cache ? { cache: options.cache } : (!options.method || options.method === 'GET') ? { cache: 'no-store' as const } : {}),
  });
  if (session && response.status === 401) clearSession(session);
  let json: unknown;
  try { json = await response.json(); } catch { throw new ApiError('INVALID_RESPONSE', response.status); }
  if (!response.ok) {
    const error = typeof json === 'object' && json !== null && 'error' in json ? json.error : null;
    const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'UNKNOWN';
    const details = error && typeof error === 'object' && 'details' in error ? error.details : undefined;
    throw new ApiError(code, response.status, details);
  }
  if (options.auth !== false && useSession.getState().version !== version) throw new ApiError('SESSION_CHANGED', response.status);
  if (!json || typeof json !== 'object' || !('data' in json)) throw new ApiError('INVALID_RESPONSE', response.status);
  return json as { data: T; nextCursor?: string | null };
}
