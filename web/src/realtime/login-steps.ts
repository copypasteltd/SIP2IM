import { create } from 'zustand';

export type Platform = 'qq' | 'telegram';
export type LoginStep = { step: 'qr' | 'phone' | 'code' | 'password'; qrPngBase64: string | null; hint: string | null };
export type LoginOperation = { kind: 'start' | 'submit' | 'logout' };
type Waiting = { phase: 'waiting'; operation: LoginOperation; accepted: boolean; candidate?: LoginStep };
type Progress = Waiting | { phase: 'missed'; operation?: LoginOperation } | { phase: 'uncertain'; operation: LoginOperation };
type Steps = Partial<Record<Platform, LoginStep>>;
type Activity = Partial<Record<Platform, Progress>>;
const platforms = ['qq', 'telegram'] as const;

export const useLoginSteps = create<{
  steps: Steps;
  progress: Activity;
  observeStep: (platform: Platform, step: LoginStep) => void;
  begin: (platform: Platform, operation: LoginOperation) => void;
  accept: (platform: Platform, operation: LoginOperation) => void;
  reject: (platform: Platform, operation: LoginOperation, uncertain: boolean) => void;
  interrupted: (platform?: Platform) => void;
  finished: (platform: Platform) => void;
  clearAll: () => void;
}>(set => ({
  steps: {}, progress: {},
  observeStep: (platform, step) => set(state => {
    const pending = state.progress[platform];
    // A socket message alone has no operation ID and must never revive a
    // disconnected, unknown, or externally started login in this console.
    if (pending?.phase !== 'waiting' || pending.operation.kind === 'logout') {
      return pending ? state : { steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: { phase: 'missed' } } };
    }
    if (pending.accepted) return { steps: { ...state.steps, [platform]: step }, progress: { ...state.progress, [platform]: undefined } };
    if (pending.candidate) return { steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: { phase: 'missed', operation: pending.operation } } };
    return { progress: { ...state.progress, [platform]: { ...pending, candidate: step } } };
  }),
  begin: (platform, operation) => set(state => ({ progress: { ...state.progress, [platform]: { phase: 'waiting', operation, accepted: false } } })),
  accept: (platform, operation) => set(state => {
    const current = state.progress[platform];
    if (current?.operation !== operation || current.phase === 'uncertain') return state;
    if (current.phase === 'missed') return { progress: { ...state.progress, [platform]: { phase: 'missed' } } };
    const next = operation.kind === 'logout' || current.candidate ? undefined : { ...current, accepted: true };
    return { steps: { ...state.steps, [platform]: operation.kind === 'logout' ? undefined : current.candidate }, progress: { ...state.progress, [platform]: next } };
  }),
  reject: (platform, operation, uncertain) => set(state => {
    const current = state.progress[platform];
    if (current?.operation !== operation) return state;
    return { progress: { ...state.progress, [platform]: uncertain ? { phase: 'uncertain', operation } : current.phase === 'waiting' ? undefined : { phase: 'missed' } } };
  }),
  interrupted: platform => set(state => {
    const steps = { ...state.steps };
    const progress = { ...state.progress };
    for (const key of platform ? [platform] : platforms) {
      const current = progress[key];
      if (steps[key] || current?.phase === 'waiting') progress[key] = { phase: 'missed', operation: current?.phase === 'waiting' && !current.accepted ? current.operation : undefined };
      steps[key] = undefined;
    }
    return { steps, progress };
  }),
  finished: platform => set(state => ({ steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: undefined } })),
  clearAll: () => set({ steps: {}, progress: {} }),
}));
