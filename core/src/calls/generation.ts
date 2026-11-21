import { callGeneration, id } from '@voipgw/protocol';
import type pg from 'pg';
import { ulid } from 'ulid';
import type { CallKind, CallState } from './coordinator.js';

export interface CallEventContext {
  /** Value negotiated by the hello of this authenticated connection. */
  callGeneration: boolean;
  /** Server-generated UUID for this connection, distinct across reconnect and restart. */
  connectionId: string;
  isCurrent(): boolean;
  /** Granted by the host only for a peer verified to enforce generation-bound rejection. */
  canReject?: boolean;
}

export interface CellularCallIdentity {
  sessionId: string;
  legId: string;
  callId: string;
  generation: string;
  connectionId: string;
}

export interface RejectTarget {
  deviceId: string;
  callId: string;
  generation: string;
  connectionId: string;
}

export interface RejectCallPort {
  /** Atomically binds a one-shot call.reject to the independently authorized live attachment.
   * The send function must recheck the exact attachment at write time and settle
   * within the transport deadline. The peer must resolve the full call identity and
   * confirm that it is still ringing atomically with the action. Hello grants no authority. */
  prepareReject(target: RejectTarget): (() => Promise<{ok: boolean; error: string | null}>) | null;
}

export const identityEvent = 'cellular.identity.v1';
export const identityConflictEvent = 'cellular.identity.conflict.v1';
const callIdSchema = id('cal');
const sessionIdSchema = id('ses');
const legIdSchema = id('leg');
const connectionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function validRejectTarget(value: Omit<RejectTarget, 'deviceId'>): boolean {
  return callIdSchema.safeParse(value.callId).success && callGeneration.safeParse(value.generation).success &&
    typeof value.connectionId === 'string' && connectionIdPattern.test(value.connectionId);
}

/** Call under the device row lock, in the transaction that creates the cellular leg.
 * A separate event makes the generation immutable without redefining the leg's ref_id. */
export async function recordCellularCallIdentity(client: pg.PoolClient, identity: CellularCallIdentity): Promise<void> {
  const { sessionId, legId, callId, generation, connectionId } = identity;
  if (!sessionIdSchema.safeParse(sessionId).success || !legIdSchema.safeParse(legId).success || !validRejectTarget(identity)) {
    throw new Error('INVALID_CALL_IDENTITY');
  }
  const owner = await client.query<{device_id: string}>(
    "SELECT s.device_id FROM call_session s JOIN call_leg l ON l.session_id=s.id WHERE s.id=$1 AND l.id=$2 AND l.type='cellular' AND l.ref_id=$3 FOR UPDATE OF s,l",
    [sessionId, legId, callId],
  );
  if (owner.rows.length !== 1) throw new Error('CALL_IDENTITY_LEG_MISMATCH');
  const existing = await client.query(
    "SELECT e.id FROM call_event e JOIN call_session s ON s.id=e.session_id WHERE e.event=$1 AND (e.session_id=$2 OR e.leg_id=$3 OR (s.device_id=$4 AND e.payload->>'generation'=$5)) LIMIT 1",
    [identityEvent, sessionId, legId, owner.rows[0]!.device_id, generation],
  );
  if (existing.rows.length !== 0) throw new Error('CALL_IDENTITY_ALREADY_BOUND');
  await client.query('INSERT INTO call_event(id,session_id,leg_id,event,payload) VALUES($1,$2,$3,$4,$5)',
    ['evt_' + ulid(), sessionId, legId, identityEvent, JSON.stringify({callId,generation,connectionId})]);
}

export interface BoundCellularCall {
  id: string;
  kind: CallKind;
  state: CallState;
  leg_id: string;
  leg_state: string;
  connection_id: string;
  call_id: string;
  quarantined: boolean;
}

/** A caller holds the device row lock. Multiple identity rows remain ambiguous. */
export async function findBoundCellularCall(client: pg.PoolClient, deviceId: string, generation: string): Promise<BoundCellularCall[]> {
  const result = await client.query<BoundCellularCall>(
    `SELECT s.id,s.kind,s.state,l.id AS leg_id,l.state AS leg_state,l.ref_id AS call_id,e.payload->>'connectionId' AS connection_id,
      EXISTS (SELECT 1 FROM call_event q WHERE q.session_id=s.id AND q.leg_id=l.id AND q.event=$4) AS quarantined
      FROM call_session s JOIN call_leg l ON l.session_id=s.id AND l.type='cellular'
      JOIN call_event e ON e.session_id=s.id AND e.leg_id=l.id AND e.event=$3 AND l.ref_id=e.payload->>'callId'
      WHERE s.device_id=$1 AND e.payload->>'generation'=$2
      ORDER BY s.id LIMIT 2 FOR UPDATE OF s,l`,
    [deviceId, generation, identityEvent, identityConflictEvent],
  );
  return result.rows;
}
