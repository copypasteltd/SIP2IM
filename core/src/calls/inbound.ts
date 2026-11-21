/** Pure decision model only: it does not send commands or establish evidence.
 * One instance represents one uniquely identified call generation. The caller must
 * serialize events and correlate every event to that call generation. A ringing
 * confirmation must be a response to this instance’s emitted check; this model
 * checks the supplied token, but cannot establish uniqueness, origin, freshness,
 * or external command execution. The caller must supply a unique token per call.
 */
export type InboundPhase = 'waiting' | 'checking' | 'answering' | 'bridged' | 'ending' | 'ended' | 'unknown';
export interface InboundState {
  phase: InboundPhase;
  platformConnected: boolean;
  mediaReady: boolean;
  checkToken: string;
}
export type InboundEvent =
  | 'platform_connected' | 'media_ready' | 'media_lost'
  | { type: 'cell_ringing_confirmed'; checkToken: string } | 'cell_not_ringing' | 'cell_active'
  | 'platform_ended' | 'cell_disconnected' | 'local_answered'
  | 'timeout' | 'answer_failed' | 'uncertain' | 'cleanup_done';
export type InboundAction = 'check_cell_ringing' | 'answer_cell' | 'bridge' | 'cleanup';
export interface InboundTransition { state: InboundState; action?: InboundAction }

export function initialInboundState(checkToken: string): InboundState {
  if (!checkToken) throw new Error('A unique check token is required');
  return { phase: 'waiting', platformConnected: false, mediaReady: false, checkToken };
}

export function transitionInbound(state: InboundState, event: InboundEvent): InboundTransition {
  if (state.phase === 'ended' || state.phase === 'unknown') return { state };
  if (state.phase === 'ending') {
    return event === 'cleanup_done' ? { state: { ...state, phase: 'ended' } } : { state };
  }
  if (event === 'uncertain') return { state: { ...state, phase: 'unknown' }, action: 'cleanup' };
  if (event === 'platform_ended' || event === 'cell_disconnected' || event === 'local_answered' || event === 'timeout' || event === 'answer_failed' || event === 'cell_not_ringing') {
    return { state: { ...state, phase: 'ending' }, action: 'cleanup' };
  }
  if (event === 'cell_active' && (state.phase === 'waiting' || state.phase === 'checking')) {
    return { state: { ...state, phase: 'unknown' }, action: 'cleanup' };
  }
  if (event === 'media_lost') {
    return { state: { ...state, mediaReady: false, phase: 'ending' }, action: 'cleanup' };
  }
  if (state.phase === 'waiting') {
    const next = { ...state, platformConnected: state.platformConnected || event === 'platform_connected', mediaReady: state.mediaReady || event === 'media_ready' };
    if (next.platformConnected && next.mediaReady) return { state: { ...next, phase: 'checking' }, action: 'check_cell_ringing' };
    return { state: next };
  }
  if (state.phase === 'checking' && typeof event !== 'string' && event.type === 'cell_ringing_confirmed' && event.checkToken === state.checkToken) {
    return { state: { ...state, phase: 'answering' }, action: 'answer_cell' };
  }
  if (state.phase === 'answering' && event === 'cell_active') {
    return { state: { ...state, phase: 'bridged' }, action: 'bridge' };
  }
  return { state };
}
