import { useState } from 'react';
import { skipToken, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { ApiError, request } from '../../api/client';

export type Settings = {
  defaultDeviceId: string | null;
  inboundRingTimeoutSec: number;
  outboundUserAnswerTimeoutSec: number;
  outboundCalleeAnswerTimeoutSec: number;
  outboundCallbackRingTimeoutSec: number;
  alertPushIntervalSec: number;
  earlyMediaThresholdDbfs: number;
  smsForward: boolean;
  smsRatePerMin: number | null;
  heartbeatSec: number;
  offlineAfterSec: number;
  botLocale: 'zh-CN' | 'zh-HK' | 'en';
};
export type ConditionalPatch = { changes: Partial<Settings>; expected: Partial<Settings> };
export const settingsKey = ['settings'] as const;
const writeKey = ['settings-write-status'] as const;
const numberFields = ['inboundRingTimeoutSec', 'outboundUserAnswerTimeoutSec', 'outboundCalleeAnswerTimeoutSec', 'outboundCallbackRingTimeoutSec', 'alertPushIntervalSec', 'earlyMediaThresholdDbfs', 'heartbeatSec', 'offlineAfterSec'] as const;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function requireSettings(s: Settings) {
  if (!s || typeof s !== 'object' || Array.isArray(s) ||
      (s.defaultDeviceId !== null && typeof s.defaultDeviceId !== 'string') ||
      !numberFields.every(field => finite(s[field])) || typeof s.smsForward !== 'boolean' ||
      (s.smsRatePerMin !== null && !finite(s.smsRatePerMin)) || !['en', 'zh-CN', 'zh-HK'].includes(s.botLocale)) {
    throw new ApiError('INVALID_RESPONSE', 200);
  }
}

export async function fetchSettings(signal?: AbortSignal) {
  const snapshot = await request<Settings>('/api/settings', { signal, cache: 'no-store' });
  requireSettings(snapshot.data);
  return snapshot;
}

async function refresh(client: QueryClient) {
  // All snapshots use the same query. Cancel the pre-write read before issuing a
  // fresh read; neither late PUT bodies nor out-of-band GETs write this cache.
  await client.cancelQueries({ queryKey: settingsKey, exact: true });
  await client.fetchQuery({ queryKey: settingsKey, queryFn: ({ signal }) => fetchSettings(signal), staleTime: 0, retry: false });
}

export type SettingsGroup = 'basic' | 'advanced';
type RecoveryReason = 'conflict' | 'uncertain' | 'committed' | 'saved';
type WriteStatus = { kind: 'idle' } | { kind: 'rejected' | 'unavailable' | 'review'; group: SettingsGroup } |
  { kind: 'saving'; group: SettingsGroup; patch: ConditionalPatch } |
  { kind: 'recovery'; group: SettingsGroup; patch: ConditionalPatch; reason: RecoveryReason; read: 'not-checked' | 'checking' | 'checked' | 'failed' };
type Recovery = Extract<WriteStatus, { kind: 'recovery' }>;
const idle: WriteStatus = { kind: 'idle' };
const mayWrite = (status: WriteStatus) => status.kind === 'idle' || status.kind === 'rejected' || status.kind === 'review';

export function useSettingsWriter() {
  const client = useQueryClient();
  // One lock for both groups, retained across settings route remounts in this session.
  const { data: status = idle } = useQuery<WriteStatus>({ queryKey: writeKey, queryFn: skipToken, enabled: false, initialData: idle, gcTime: Infinity });
  const current = () => client.getQueryData<WriteStatus>(writeKey) ?? idle;
  const set = (next: WriteStatus) => client.setQueryData(writeKey, next);
  async function check(recovery: Recovery) {
    const checking: Recovery = { ...recovery, read: 'checking' };
    const owned = set(checking);
    try {
      await refresh(client);
      if (current() !== owned) return;
      if (checking.reason === 'conflict') set({ kind: 'review', group: checking.group });
      else if (checking.reason === 'saved') set(idle);
      else set({ ...checking, read: 'checked' });
    } catch {
      if (current() === owned) set({ ...checking, read: 'failed' });
    }
  }
  async function save(group: SettingsGroup, payload: ConditionalPatch) {
    if (!mayWrite(current()) || !Object.keys(payload.changes).length) return;
    const owned = set({ kind: 'saving', group, patch: payload });
    try {
      // Never write optimistically or retry, including against a legacy endpoint.
      const result = await request<Settings>('/api/settings/conditional', { method: 'PUT', body: payload });
      requireSettings(result.data);
    } catch (error) {
      if (current() !== owned) return;
      if (error instanceof ApiError) {
        if (error.status === 409 && error.code === 'SETTINGS_CONFLICT') {
          await check({ kind: 'recovery', group, patch: payload, reason: 'conflict', read: 'not-checked' });
          return;
        }
        if (error.status === 404 || error.status === 405) { set({ kind: 'unavailable', group }); return; }
        if (error.status === 400 || error.status === 401 || error.status === 403) { set({ kind: 'rejected', group }); return; }
        if (error.code === 'SETTINGS_WRITE_COMMITTED_EFFECTS_UNKNOWN') {
          set({ kind: 'recovery', group, patch: payload, reason: 'committed', read: 'not-checked' });
          return;
        }
      }
      set({ kind: 'recovery', group, patch: payload, reason: 'uncertain', read: 'not-checked' });
      return;
    }
    if (current() === owned) await check({ kind: 'recovery', group, patch: payload, reason: 'saved', read: 'not-checked' });
  }
  function checkCurrent() {
    const next = current();
    if (next.kind === 'recovery' && next.read !== 'checking') void check(next);
  }
  function acknowledge() {
    const next = current();
    if (next.kind === 'recovery' && next.read === 'checked') set({ kind: 'review', group: next.group });
  }
  function restore<K extends keyof Settings>(key: K) {
    if (status.kind !== 'saving' && status.kind !== 'recovery') return;
    const value = status.patch.changes[key];
    const base = status.patch.expected[key];
    if (value !== undefined && base !== undefined) return { value, base };
  }
  return { status, blocked: !mayWrite(status), save, checkCurrent, acknowledge, restore };
}

// Keep the typed server baseline separately from the input representation.
export function useSettingDraft<T, Input>(source: T, format: (value: T) => Input, parse: (input: Input) => T | undefined, protect: boolean, recovered?: { value: T; base: T }) {
  const fresh = () => ({ value: format(source), base: source, seen: source });
  const [state, setState] = useState(() => recovered ? { value: format(recovered.value), base: recovered.base, seen: source } : fresh());
  let current = state;
  if (!Object.is(state.seen, source) || (!protect && !Object.is(state.base, source) && Object.is(parse(state.value), source))) {
    const clean = Object.is(state.value, format(state.base)) && Object.is(state.seen, state.base);
    current = clean || (!protect && Object.is(parse(state.value), source)) ? fresh() : { ...state, seen: source };
    setState(current);
  }
  const parsed = parse(current.value);
  return {
    value: current.value, expected: current.base, parsed,
    dirty: parsed !== undefined && !Object.is(parsed, source),
    conflict: !Object.is(current.base, source) && !Object.is(parsed, source),
    set: (value: Input) => setState(d => ({ ...d, value })),
    latest: () => setState(fresh()),
    keep: () => setState(d => ({ ...d, base: source, seen: source })),
  };
}

export const identity = <T>(value: T) => value;
export function numberInput(value: string, min = 1, max = Infinity): number | undefined {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : undefined;
}
export function addSetting<K extends keyof Settings>(patch: ConditionalPatch, field: K, draft: { expected: Settings[K]; parsed: Settings[K] | undefined; dirty: boolean }) {
  if (draft.dirty && draft.parsed !== undefined) {
    patch.changes[field] = draft.parsed;
    patch.expected[field] = draft.expected;
  }
}
