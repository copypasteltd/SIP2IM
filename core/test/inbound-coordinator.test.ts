import { describe, expect, it } from 'vitest';
import { initialInboundState, transitionInbound, type InboundEvent } from '../src/calls/inbound.js';
import { transitionCall } from '../src/calls/coordinator.js';

const confirmation = { type: 'cell_ringing_confirmed', checkToken: 'check-1' } as const;

function run(events: InboundEvent[]) {
  let state = initialInboundState('check-1');
  const actions: string[] = [];
  for (const event of events) {
    const result = transitionInbound(state, event);
    state = result.state;
    if (result.action) actions.push(result.action);
  }
  return { state, actions };
}

describe('isolated inbound coordinator', () => {
  it.each([
    ['platform_connected', 'media_ready'],
    ['media_ready', 'platform_connected'],
  ] as InboundEvent[][])('requires both signals, then a fresh ringing confirmation: %s', (...events) => {
    expect(run([...events]).actions).toEqual(['check_cell_ringing']);
    expect(run([...events, confirmation, 'cell_active']).actions).toEqual(['check_cell_ringing', 'answer_cell', 'bridge']);
  });
  it('ignores early confirmation and duplicate events', () => {
    expect(run([confirmation,'platform_connected','platform_connected','media_ready','media_ready',confirmation,confirmation,'cell_active','cell_active']).actions).toEqual(['check_cell_ringing','answer_cell','bridge']);
  });
  it.each(['platform_ended','cell_disconnected','local_answered','timeout','cell_not_ringing','uncertain'] as InboundEvent[])('never answers after %s', terminal => {
    const result = run(['platform_connected','media_ready',terminal,confirmation,'platform_connected','media_ready']);
    expect(result.actions).not.toContain('answer_cell');
    expect(result.actions.filter(a => a === 'cleanup')).toHaveLength(1);
  });
  it('ignores a confirmation from a different check', () => {
    expect(run(['platform_connected','media_ready',{type:'cell_ringing_confirmed',checkToken:'old-check'}]).actions).toEqual(['check_cell_ringing']);
    expect(run(['platform_connected','media_ready',{type:'cell_ringing_confirmed',checkToken:'old-check'},confirmation]).actions).toEqual(['check_cell_ringing','answer_cell']);
  });
  it('does not re-arm on stale readiness after early media loss', () => {
    expect(run(['media_lost','media_ready','platform_connected',confirmation]).actions).toEqual(['cleanup']);
    expect(() => initialInboundState('')).toThrow();
  });
  it('invalidates an outstanding check on media loss', () => {
    expect(run(['platform_connected','media_ready','media_lost',confirmation,'media_ready',confirmation]).actions).toEqual(['check_cell_ringing','cleanup']);
  });
  it('treats cellular active before our answer as uncertain', () => {
    const result = run(['cell_active','platform_connected','media_ready',confirmation]);
    expect(result.state.phase).toBe('unknown');
    expect(result.actions).toEqual(['cleanup']);
  });
  it('never emits an answer from the legacy incomplete helper', () => {
    expect(transitionCall('platform_in','platform_dialing','platform_connected').action).toBeUndefined();
  });
  it('preserves the gate across all short event sequences', () => {
    const events: InboundEvent[] = ['platform_connected','media_ready',confirmation,'media_lost','platform_ended','cell_disconnected','local_answered','timeout','uncertain'];
    for (let sequence = 0; sequence < events.length ** 5; sequence++) {
      let n = sequence, state = initialInboundState('check-1'), connected = false, ready = false, checking = false, answers = 0, terminal = false;
      for (let i = 0; i < 5; i++) {
        const event = events[n % events.length]!; n = Math.floor(n / events.length);
        const result = transitionInbound(state, event);
        if (event === 'platform_connected' && !terminal) connected = true;
        if (event === 'media_ready' && !terminal) ready = true;
        if (event === 'media_lost') { ready = false; checking = false; }
        if (typeof event === 'string' && ['platform_ended','cell_disconnected','local_answered','timeout','uncertain','media_lost'].includes(event)) terminal = true;
        if (result.action === 'check_cell_ringing') checking = true;
        if (result.action === 'answer_cell') {
          answers++; expect(connected && ready && checking && !terminal && event === confirmation).toBe(true);
        }
        if (answers > 1) throw new Error('answer emitted more than once');
        state = result.state;
      }
    }
  });
});
