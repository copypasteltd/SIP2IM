import { useRef, useState } from 'react';

/** Track the last observed server value separately from the value being edited. */
export function useAuthoritativeDraft<T extends string | null>(id: string, source: T) {
  const [state, setState] = useState(() => ({ id, source, baseline: source, latest: source, draft: source }));
  let current = state;
  if (state.id !== id) {
    current = { id, source, baseline: source, latest: source, draft: source };
    setState(current);
  } else if (state.source !== source) {
    current = state.draft === state.baseline
      ? { ...state, source, baseline: source, latest: source, draft: source }
      : { ...state, source, latest: source };
    setState(current);
  }
  const currentRef = useRef(current);
  currentRef.current = current;
  const conflict = current.latest !== current.baseline;
  return {
    value: current.draft,
    baseline: current.baseline,
    conflict,
    setValue: (draft: T) => setState(s => ({ ...s, draft })),
    observe: (latest: T) => setState(s => s.draft === s.baseline ? { ...s, baseline: latest, latest, draft: latest } : { ...s, latest }),
    reload: () => setState(s => ({ ...s, baseline: s.latest, draft: s.latest })),
    isCurrent: () => currentRef.current.id === id && currentRef.current.baseline === current.baseline && currentRef.current.latest === current.latest && currentRef.current.draft === current.draft,
    saved: (value: T) => setState(s => s.id === id && s.baseline === current.baseline && s.draft === current.draft && (s.latest === current.latest || s.latest === value) ? { ...s, baseline: value, latest: value, draft: value } : s),
  };
}
