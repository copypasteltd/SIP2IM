import { create } from 'zustand';

export type Platform = 'qq' | 'telegram';
export type LoginStep = { challengeId: string; step: 'qr' | 'phone' | 'code' | 'password'; qrPngBase64: string | null; hint: string | null };
export type LoginOperation = { kind: 'start' | 'submit' | 'logout' };
type Waiting = { phase: 'waiting'; operation: LoginOperation; accepted: boolean; candidate?: LoginStep };
type Progress = Waiting | { phase: 'missed'; operation?: LoginOperation } | { phase: 'uncertain'; operation: LoginOperation };
type Steps = Partial<Record<Platform, LoginStep>>;
type Activity = Partial<Record<Platform, Progress>>;
type Versions = Record<Platform, number>;
const platforms = ['qq', 'telegram'] as const;
const challengePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function parseLoginStep(value: unknown): LoginStep | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const { challengeId, step, qrPngBase64, hint } = value as Record<string, unknown>;
  if (typeof challengeId !== 'string' || challengeId.length !== 36 || !challengePattern.test(challengeId) ||
      (step !== 'qr' && step !== 'phone' && step !== 'code' && step !== 'password') ||
      (qrPngBase64 !== null && typeof qrPngBase64 !== 'string') || (hint !== null && typeof hint !== 'string')) return undefined;
  return { challengeId, step, qrPngBase64, hint };
}

export function canReadLoginStep(progress: Progress | undefined): boolean {
  return !progress || (progress.phase === 'missed' && !progress.operation) ||
    (progress.phase === 'waiting' && progress.accepted && progress.operation.kind !== 'logout');
}

const bump = (versions: Versions, platform: Platform): Versions => ({ ...versions, [platform]: versions[platform] + 1 });

export const useLoginSteps = create<{
  steps: Steps;
  progress: Activity;
  versions: Versions;
  observeStep: (platform: Platform, step: LoginStep) => void;
  restoreStep: (platform: Platform, expected: number, step: LoginStep | null) => boolean;
  begin: (platform: Platform, operation: LoginOperation) => void;
  accept: (platform: Platform, operation: LoginOperation) => void;
  reject: (platform: Platform, operation: LoginOperation, uncertain: boolean) => void;
  interrupted: (platform?: Platform) => void;
  finished: (platform: Platform) => void;
  clearAll: () => void;
}>((set) => ({
  steps: {}, progress: {}, versions: { qq: 0, telegram: 0 },
  observeStep: (platform, step) => set(state => {
    const pending = state.progress[platform];
    const displayed = state.steps[platform];
    if (displayed?.challengeId === step.challengeId || (pending?.phase === 'waiting' && pending.candidate?.challengeId === step.challengeId)) return state;
    const versions = bump(state.versions, platform);
    // An unsolicited socket hint cannot open a form. Invalidate an older form and
    // require a readback (or the accepted local command's normal prompt handoff).
    if (pending?.phase !== 'waiting' || pending.operation.kind === 'logout') {
      return pending ? { versions } : { versions, steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: { phase: 'missed' } } };
    }
    if (pending.accepted) return { versions, steps: { ...state.steps, [platform]: step }, progress: { ...state.progress, [platform]: undefined } };
    if (pending.candidate) return { versions, steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: { phase: 'missed', operation: pending.operation } } };
    return { versions, progress: { ...state.progress, [platform]: { ...pending, candidate: step } } };
  }),
  restoreStep: (platform, expected, step) => {
    let restored = false;
    set(state => {
      if (state.versions[platform] !== expected || !canReadLoginStep(state.progress[platform])) return state;
      restored = true;
      return {
        versions: bump(state.versions, platform),
        steps: { ...state.steps, [platform]: step ?? undefined },
        progress: { ...state.progress, [platform]: step ? undefined : { phase: 'missed' } },
      };
    });
    return restored;
  },
  begin: (platform, operation) => set(state => ({
    versions: bump(state.versions, platform),
    progress: { ...state.progress, [platform]: { phase: 'waiting', operation, accepted: false } },
  })),
  accept: (platform, operation) => set(state => {
    const current = state.progress[platform];
    if (current?.operation !== operation || current.phase === 'uncertain') return state;
    const versions = bump(state.versions, platform);
    if (current.phase === 'missed') return { versions, steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: { phase: 'missed' } } };
    const next = operation.kind === 'logout' || current.candidate ? undefined : { ...current, accepted: true };
    return { versions, steps: { ...state.steps, [platform]: operation.kind === 'logout' ? undefined : current.candidate }, progress: { ...state.progress, [platform]: next } };
  }),
  reject: (platform, operation, uncertain) => set(state => {
    const current = state.progress[platform];
    if (current?.operation !== operation) return state;
    const next: Progress | undefined = uncertain ? { phase: 'uncertain', operation } :
      (current.phase === 'missed' || operation.kind === 'submit' ? { phase: 'missed' } : undefined);
    return { versions: bump(state.versions, platform), steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: next } };
  }),
  interrupted: platform => set(state => {
    const steps = { ...state.steps };
    const progress = { ...state.progress };
    const versions = { ...state.versions };
    for (const key of platform ? [platform] : platforms) {
      const current = progress[key];
      if (current?.phase === 'waiting') progress[key] = { phase: 'missed', operation: current.accepted ? undefined : current.operation };
      else if (!current && steps[key]) progress[key] = { phase: 'missed' };
      steps[key] = undefined;
      versions[key]++;
    }
    return { steps, progress, versions };
  }),
  finished: platform => set(state => {
    const current = state.progress[platform];
    // A channel state notification cannot settle a command with no reply.
    const next = current?.phase === 'uncertain' || (current?.phase === 'missed' && current.operation) ? current :
      current?.phase === 'waiting' && !current.accepted ? { phase: 'missed' as const, operation: current.operation } : undefined;
    return { versions: bump(state.versions, platform), steps: { ...state.steps, [platform]: undefined }, progress: { ...state.progress, [platform]: next } };
  }),
  clearAll: () => set(state => ({ steps: {}, progress: {}, versions: { qq: state.versions.qq + 1, telegram: state.versions.telegram + 1 } })),
}));
