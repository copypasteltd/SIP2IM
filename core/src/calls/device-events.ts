import type pg from 'pg';
import { ulid } from 'ulid';
import { transaction } from '../db/pool.js';
import type { CallKind, CallState } from './coordinator.js';
import {
  findBoundCellularCall, identityConflictEvent, identityEvent, recordCellularCallIdentity, validRejectTarget,
  type CallEventContext, type RejectCallPort, type RejectTarget,
} from './generation.js';

interface Event { id: string; type: string; ts: number; payload: unknown }
interface CellPayload {
  callId: string;
  generation?: string;
  state: 'ringing' | 'dialing' | 'alerting' | 'active' | 'disconnected';
  cause: string | null;
  slot: number | null;
  subId: number | null;
  from: string | null;
  fromKind: string;
}
interface LegRow { id: string; kind: CallKind; state: CallState; leg_id: string; leg_state: string }
const earlyStateProvenance = 'core:cellular.state-admission.v1';

/** Runs in the transaction that persists the raw device event. Replacement must
 * wait for admitted call-event transactions before making another socket current. */
export async function persistCallDeviceEvent(
  client: pg.PoolClient, deviceId: string, event: Event, context?: CallEventContext,
): Promise<void> {
  const payload = event.payload as CellPayload | null;
  if ((event.type !== 'call.incoming' && event.type !== 'call.state') || !payload || typeof payload.callId !== 'string') return;
  if (context && !context.isCurrent()) return;
  await client.query('SELECT id FROM device WHERE id=$1 FOR UPDATE', [deviceId]);
  if (context && !context.isCurrent()) return;

  if (context?.callGeneration === true && payload.generation !== undefined &&
      validRejectTarget({callId: payload.callId, generation: payload.generation, connectionId: context.connectionId})) {
    await projectGenerationEvent(client, deviceId, event, payload, payload.generation, context);
  } else if (context?.callGeneration !== true && payload.generation === undefined) {
    await projectLegacyEvent(client, deviceId, event, payload, context);
  }
  // No capability downgrade: an unnegotiated generation or a missing negotiated
  // generation remains raw evidence only and cannot affect a known call.
}

async function projectGenerationEvent(
  client: pg.PoolClient, deviceId: string, event: Event, payload: CellPayload, generation: string, context: CallEventContext,
): Promise<void> {
  const candidates = await findBoundCellularCall(client, deviceId, generation);
  if (candidates.length > 1 || !context.isCurrent()) return;
  const row = candidates[0];
  if (row && (row.quarantined || !validRejectTarget({callId:row.call_id, generation, connectionId:row.connection_id}))) return;

  if (row && (row.call_id !== payload.callId || event.type === 'call.incoming')) {
    // Exact wire retries are handled by DeviceEvents. A different incoming
    // envelope for an existing generation, or another callId, is ambiguous.
    await client.query('INSERT INTO call_event(id,session_id,leg_id,event,payload) VALUES($1,$2,$3,$4,$5)',
      [event.id, row.id, row.leg_id, identityConflictEvent, JSON.stringify({callId: payload.callId, generation})]);
    await invalidateReject(client, row.id);
    if (row.state !== 'ended' && row.state !== 'unknown')
      await setCallState(client, row.id, row.state, 'unknown', 'call_generation_reused', 'unknown');
    return;
  }

  if (event.type === 'call.incoming') {
    let reason = 'platform_unavailable';
    let eligible = context.canReject === true;
    // Earlier active/terminal evidence makes automatic action unsafe. Only a
    // terminal event with Core-owned provenance may be replayed into this leg.
    const terminal = await findEarlyTerminal(client, deviceId, payload, generation, context.connectionId, new Date(event.ts));
    const prior = await client.query<{conflict: boolean}>(`SELECT (d.payload->>'callId' IS DISTINCT FROM $3 OR d.type='call.incoming') AS conflict
      FROM device_event d WHERE d.device_id=$1 AND d.id<>$4
      AND d.type IN ('call.incoming','call.state') AND d.payload->>'generation'=$2
      AND (d.payload->>'callId' IS DISTINCT FROM $3 OR d.type='call.incoming' OR d.payload->>'state' IN ('active','disconnected'))
      ORDER BY conflict DESC LIMIT 1`, [deviceId, generation, payload.callId, event.id]);
    const conflict = prior.rows[0]?.conflict === true;
    if (prior.rows.length || terminal) { eligible = false; reason = conflict ? 'call_generation_reused' : 'earlier_unbound_call_state'; }
    if (eligible) {
      const fresh = await client.query<{fresh: boolean}>(
        "SELECT $1::timestamptz BETWEEN clock_timestamp()-interval '60 seconds' AND clock_timestamp() AS fresh", [new Date(event.ts)]);
      if (fresh.rows[0]?.fresh !== true) { eligible = false; reason = 'incoming_time_untrusted'; }
    }
    if (!context.isCurrent()) return;
    const state = eligible ? 'rejecting' : 'unknown';
    const {sessionId, legId} = await createIncoming(client, deviceId, event, payload, state, reason);
    await recordCellularCallIdentity(client, {sessionId, legId, callId: payload.callId, generation, connectionId: context.connectionId});
    if (conflict) {
      await client.query('INSERT INTO call_event(id,session_id,leg_id,event,payload) VALUES($1,$2,$3,$4,$5)',
        ['evt_' + ulid(), sessionId, legId, identityConflictEvent, JSON.stringify({callId:payload.callId,generation})]);
    } else if (terminal) {
      await projectCellState(client, terminal.id, {
        id: sessionId, kind: 'platform_in', state, leg_id: legId, leg_state: 'ringing',
      }, terminal.payload, true);
    } else if (eligible) {
      await client.query("INSERT INTO call_reject_intent(session_id,device_id,call_id,state,expires_at) VALUES($1,$2,$3,'pending',$4::timestamptz+interval '60 seconds')",
        [sessionId, deviceId, payload.callId, new Date(event.ts)]);
    }
    return;
  }

  if (!row) {
    if (payload.state === 'disconnected') {
      await recordEarlyTerminal(client, deviceId, event, context.connectionId);
    }
    return;
  }
  // A newly negotiated socket may report a terminal state for a known generation.
  // It cannot resume a previous connection's operational leg or command authority.
  if (row.connection_id !== context.connectionId && payload.state !== 'disconnected') return;
  await projectCellState(client, event.id, row, payload, true);
}

async function recordEarlyTerminal(client: pg.PoolClient, deviceId: string, event: Event, connectionId: string | null): Promise<void> {
  // Core owns this marker type. DeviceEvents never admits that type from the wire.
  await client.query('INSERT INTO device_event(id,device_id,type,payload,device_ts) VALUES($1,$2,$3,$4,$5)',
    ['evt_' + ulid(), deviceId, earlyStateProvenance, JSON.stringify({sourceEventId:event.id, connectionId}), new Date(event.ts)]);
}

async function findEarlyTerminal(
  client: pg.PoolClient, deviceId: string, payload: CellPayload, generation: string | null, connectionId: string | null, incomingAt: Date,
): Promise<{id: string; payload: CellPayload} | undefined> {
  const result = await client.query<{id: string; payload: CellPayload}>(`SELECT d.id,d.payload FROM device_event p
    JOIN device_event d ON d.id=p.payload->>'sourceEventId' AND d.device_id=p.device_id
    WHERE p.device_id=$1 AND p.type=$2 AND p.payload->>'connectionId' IS NOT DISTINCT FROM $3::text
      AND p.received_at>=clock_timestamp()-interval '60 seconds' AND p.device_ts=d.device_ts
      AND d.type='call.state' AND d.payload->>'callId'=$4 AND d.payload->>'state'='disconnected'
      AND (CASE WHEN $5::text IS NULL THEN NOT (d.payload ? 'generation') ELSE d.payload->>'generation'=$5 END)
      AND d.device_ts BETWEEN $6::timestamptz AND $6::timestamptz+interval '60 seconds'
      AND NOT EXISTS (SELECT 1 FROM call_event e WHERE e.id=d.id)
    ORDER BY d.device_ts DESC,d.received_at DESC,d.id LIMIT 1`,
    [deviceId, earlyStateProvenance, connectionId, payload.callId, generation, incomingAt]);
  return result.rows[0];
}

async function projectLegacyEvent(
  client: pg.PoolClient, deviceId: string, event: Event, payload: CellPayload, context?: CallEventContext,
): Promise<void> {
  const quarantine = await client.query('SELECT 1 FROM call_identity_quarantine WHERE device_id=$1 AND call_id=$2', [deviceId, payload.callId]);
  if (quarantine.rowCount) return;
  // Once a callId has a versioned binding, a callId-only frame cannot be attributed
  // even to an older legacy row that used the same ID.
  const reserved = await client.query(`SELECT 1 FROM call_session s JOIN call_event e ON e.session_id=s.id
    WHERE s.device_id=$1 AND e.event=$3 AND e.payload->>'callId'=$2 LIMIT 1`, [deviceId, payload.callId, identityEvent]);
  if (reserved.rowCount) return;
  const found = await client.query<LegRow>(`SELECT s.id,s.kind,s.state,l.id AS leg_id,l.state AS leg_state
    FROM call_session s JOIN call_leg l ON l.session_id=s.id AND l.type='cellular'
    WHERE s.device_id=$1 AND l.ref_id=$2 ORDER BY s.started_at DESC LIMIT 1 FOR UPDATE OF s,l`, [deviceId, payload.callId]);
  const row = found.rows[0];
  if (context && !context.isCurrent()) return;
  if (event.type === 'call.state') {
    if (row) await projectCellState(client, event.id, row, payload, false);
    else if (payload.state === 'disconnected') await recordEarlyTerminal(client, deviceId, event, context?.connectionId ?? null);
    return;
  }

  if (row) {
    await client.query('INSERT INTO call_identity_quarantine(device_id,call_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [deviceId, payload.callId]);
    await invalidateReject(client, row.id);
    await invalidateCallback(client, row.id);
    if (row.state !== 'ended' && row.state !== 'unknown')
      await setCallState(client, row.id, row.state, 'unknown', 'call_id_collision', 'unknown');
    const collision = 'ses_' + ulid();
    await client.query("INSERT INTO call_session(id,kind,device_id,peer,peer_kind,state,end_cause) VALUES($1,'platform_in',$2,$3,$4,'unknown','unknown')",
      [collision, deviceId, payload.from, payload.fromKind]);
    await client.query("INSERT INTO call_event(id,session_id,event,payload) VALUES($1,$2,'state:unknown',$3)",
      [event.id, collision, JSON.stringify({reason:'call_id_collision',callId:payload.callId})]);
    return;
  }

  const {sessionId, legId} = await createIncoming(client, deviceId, event, payload, 'unknown', 'call_generation_unavailable');
  // Raw legacy rows from before this change and downgraded sessions lack matching
  // Core admission evidence. Retain those observations without asserting an end.
  const terminal = await findEarlyTerminal(client, deviceId, payload, null, context?.connectionId ?? null, new Date(event.ts));
  if (terminal) await projectCellState(client, terminal.id, {
    id: sessionId, kind: 'platform_in', state: 'unknown', leg_id: legId, leg_state: 'ringing',
  }, terminal.payload, false);
}

async function createIncoming(
  client: pg.PoolClient, deviceId: string, event: Event, payload: CellPayload, state: 'unknown' | 'rejecting', reason: string,
): Promise<{sessionId: string; legId: string}> {
  const nullableInt4 = (value: number | null, min: number) => value === null || Number.isInteger(value) && value >= min && value <= 2_147_483_647;
  // Unrepresentable selectors cannot establish SIM attribution. Keep the call history.
  const sim = nullableInt4(payload.slot, 0) && nullableInt4(payload.subId, -2_147_483_648)
    ? (await client.query<{id: string}>(`SELECT s.id FROM sim s JOIN device d ON d.id=s.device_id
        WHERE s.device_id=$1 AND s.retired_at IS NULL
          AND s.slot=CASE WHEN $2::int IS NOT NULL THEN $2::int WHEN d.api_level<22 THEN 0 ELSE NULL END
          AND ($3::int IS NULL OR s.sub_id=$3)`, [deviceId, payload.slot, payload.subId])).rows[0]?.id ?? null
    : null;
  const sessionId = 'ses_' + ulid();
  const legId = 'leg_' + ulid();
  await client.query("INSERT INTO call_session(id,kind,device_id,sim_id,peer,peer_kind,state,end_cause) VALUES($1,'platform_in',$2,$3,$4,$5,$6,'unknown')",
    [sessionId, deviceId, sim, payload.from, payload.fromKind, state]);
  await client.query("INSERT INTO call_leg(id,session_id,type,ref_id,state) VALUES($1,$2,'cellular',$3,'ringing')", [legId, sessionId, payload.callId]);
  await client.query('INSERT INTO call_event(id,session_id,leg_id,event,payload) VALUES($1,$2,$3,$4,$5)',
    [event.id, sessionId, legId, 'state:' + state, JSON.stringify({reason, sourceEventId:event.id})]);
  return {sessionId, legId};
}

async function invalidateReject(client: pg.PoolClient, sessionId: string): Promise<void> {
  await client.query("UPDATE call_reject_intent SET state='unknown',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND state IN ('pending','sending','accepted')", [sessionId]);
}

async function invalidateCallback(client: pg.PoolClient, sessionId: string): Promise<void> {
  await client.query("UPDATE call_outbound_attempt SET callback_intent='unknown',updated_at=now() WHERE session_id=$1 AND callback_intent='quarantined'", [sessionId]);
}

async function projectCellState(
  client: pg.PoolClient, eventId: string, row: LegRow, payload: CellPayload, bound: boolean,
): Promise<void> {
  await client.query("INSERT INTO call_event(id,session_id,leg_id,event,payload) VALUES($1,$2,$3,'device:call.state',$4)",
    [eventId, row.id, row.leg_id, JSON.stringify(payload)]);
  if (row.kind === 'platform_out' && (row.state === 'ended' || payload.state === 'disconnected')) await invalidateCallback(client, row.id);
  const terminal = payload.state === 'disconnected';
  if (row.state === 'ended' && !(bound && terminal)) return;
  if (!terminal && (row.leg_state === 'disconnected' || (row.leg_state === 'active' && payload.state !== 'active'))) return;
  if (row.leg_state !== 'disconnected') await client.query(`UPDATE call_leg SET state=$2,connected_at=CASE WHEN $2='active' THEN COALESCE(connected_at,now()) ELSE connected_at END,
    ended_at=CASE WHEN $2='disconnected' THEN COALESCE(ended_at,now()) ELSE ended_at END,
    end_cause=CASE WHEN $2='disconnected' THEN $3 ELSE end_cause END,updated_at=now() WHERE id=$1`, [row.leg_id, payload.state, payload.cause]);
  if (terminal) {
    await client.query("UPDATE call_reject_intent SET state='done',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND state<>'done'", [row.id]);
    if (row.state === 'ended') return;
    // Existing legacy outbound sessions can have an unresolved second leg.
    const next = row.kind === 'platform_in' || (bound && row.kind === 'web_out') ? 'ended' : row.state === 'unknown' ? 'unknown' : 'ending';
    if (next !== row.state) await setCallState(client, row.id, row.state, next, 'cell_disconnected', payload.cause);
    return;
  }
  const dialing = row.state === 'cell_dialing' && payload.cause !== 'local_answered' &&
    (row.kind === 'platform_out' || (bound && row.kind === 'web_out'));
  if ((row.kind === 'platform_in' && row.state === 'rejecting' && payload.state !== 'ringing') ||
      (row.kind !== 'platform_in' && payload.state === 'active' && row.state !== 'unknown' && row.state !== 'bridged' && !dialing)) {
    await invalidateReject(client, row.id);
    if (row.kind === 'platform_out') await invalidateCallback(client, row.id);
    await setCallState(client, row.id, row.state, 'unknown', 'cell_active_or_unexpected_state', 'unknown');
  }
  // Browser media readiness/ACK belongs to the outbound coordinator. An active
  // observation alone must not set the session's bridged state.
}

export async function setCallState(client: pg.PoolClient, id: string, from: CallState, to: CallState, reason: string, cause: string | null): Promise<boolean> {
  const result = await client.query(`UPDATE call_session SET state=$3,updated_at=now(),
    answered_at=CASE WHEN $3='bridged' THEN COALESCE(answered_at,now()) ELSE answered_at END,
    ended_at=CASE WHEN $3='ended' THEN COALESCE(ended_at,now()) ELSE ended_at END,
    end_cause=COALESCE($4,end_cause) WHERE id=$1 AND state=$2`, [id, from, to, cause]);
  if (!result.rowCount) return false;
  await client.query('INSERT INTO call_event(id,session_id,event,payload) VALUES($1,$2,$3,$4)', ['evt_' + ulid(), id, 'state:' + to, JSON.stringify({reason})]);
  return true;
}

interface RejectRow { session_id: string; device_id: string; call_id: string; generation: string; connection_id: string }
const validIntent = `FROM call_reject_intent i JOIN call_session s ON s.id=i.session_id AND s.device_id=i.device_id
  JOIN device d ON d.id=i.device_id AND d.enabled=true AND d.revoked_at IS NULL
  JOIN call_leg l ON l.session_id=s.id AND l.type='cellular' AND l.ref_id=i.call_id AND l.state='ringing'
  JOIN call_event e ON e.session_id=s.id AND e.leg_id=l.id AND e.event=$2 AND e.payload->>'callId'=i.call_id
  WHERE s.kind='platform_in' AND s.state='rejecting' AND i.expires_at>clock_timestamp()
    AND (i.state<>'sending' OR i.lease_until>clock_timestamp())
    AND NOT EXISTS (SELECT 1 FROM call_event q WHERE q.session_id=s.id AND q.leg_id=l.id AND q.event=$3)`;

/** Recovery runs everywhere. Egress is supplied only by an independently verified port. */
export class RejectIntentWorker {
  private stopped = false;
  private dirty = false;
  private active?: Promise<void>;
  constructor(private readonly pool: pg.Pool, private readonly port?: RejectCallPort) {}

  flush(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.active) { this.dirty = true; return this.active; }
    this.active = Promise.resolve().then(async () => {
      try { do { this.dirty = false; await this.run(); } while (this.dirty && !this.stopped); }
      finally { this.active = undefined; }
    });
    return this.active;
  }

  /** Close admission synchronously and drain the admitted claim, send, and outcome write. */
  stop(): Promise<void> {
    this.stopped = true;
    return this.active ?? Promise.resolve();
  }

  private async run(): Promise<void> {
    if (this.stopped) return;
    const timedOut = `((state='sending' AND (lease_until<=clock_timestamp() OR expires_at<=clock_timestamp()))
      OR (state IN ('pending','accepted') AND expires_at<=clock_timestamp()))`;
    const expired = await this.pool.query<{session_id: string}>(`SELECT session_id FROM call_reject_intent WHERE ${timedOut}`);
    for (const row of expired.rows) {
      if (this.stopped) return;
      await transaction(this.pool, async client => {
        await client.query('SELECT id FROM call_session WHERE id=$1 FOR UPDATE', [row.session_id]);
        const changed = await client.query(`UPDATE call_reject_intent SET state='unknown',lease_until=NULL,updated_at=now() WHERE session_id=$1 AND ${timedOut}`, [row.session_id]);
        if (changed.rowCount) await setCallState(client, row.session_id, 'rejecting', 'unknown', 'reject_unconfirmed', 'unknown');
      });
    }
    if (this.stopped || !this.port) return;
    const pending = await this.pool.query<RejectRow>(`SELECT i.session_id,i.device_id,i.call_id,e.payload->>'generation' AS generation,e.payload->>'connectionId' AS connection_id
      ${validIntent} AND i.state=$1 ORDER BY i.updated_at,i.session_id`, ['pending', identityEvent, identityConflictEvent]);
    for (const row of pending.rows) {
      if (this.stopped) return;
      const target = {deviceId:row.device_id, callId:row.call_id, generation:row.generation, connectionId:row.connection_id};
      if (!validRejectTarget(target)) continue;
      const claimed = await this.claim(row.session_id, target);
      if (!claimed || this.stopped) continue;
      const valid = await this.pool.query(`SELECT 1 ${validIntent} AND i.state=$1 AND i.session_id=$4 AND i.device_id=$5
        AND i.call_id=$6 AND e.payload->>'generation'=$7 AND e.payload->>'connectionId'=$8`,
        ['sending', identityEvent, identityConflictEvent, row.session_id, target.deviceId, target.callId, target.generation, target.connectionId]);
      if (this.stopped) return;
      if (valid.rows.length !== 1) continue;
      let accepted = false;
      let reason = 'reject_unconfirmed';
      try {
        const send = this.port.prepareReject(target);
        if (send && !this.stopped) {
          const acknowledgement = await send();
          accepted = acknowledgement.ok === true && acknowledgement.error === null;
          if (!accepted) reason = 'reject_failed';
        } else { reason = 'reject_connection_unverified'; }
      } catch { /* Crossing the command boundary can leave the outcome unknown. */ }
      await transaction(this.pool, async client => {
        await client.query('SELECT id FROM call_session WHERE id=$1 FOR UPDATE', [row.session_id]);
        const changed = await client.query<{state: 'accepted' | 'unknown'}>(`UPDATE call_reject_intent
          SET state=CASE WHEN $2='accepted' AND lease_until>clock_timestamp() AND expires_at>clock_timestamp()
                         THEN 'accepted' ELSE 'unknown' END,lease_until=NULL,updated_at=now()
          WHERE session_id=$1 AND state='sending' RETURNING state`, [row.session_id, accepted ? 'accepted' : 'unknown']);
        if (changed.rows[0]?.state === 'unknown') {
          await setCallState(client, row.session_id, 'rejecting', 'unknown', accepted ? 'reject_unconfirmed' : reason, 'unknown');
        }
      });
    }
  }

  private claim(sessionId: string, target: RejectTarget): Promise<boolean> {
    return transaction(this.pool, async client => {
      // Device → session → intent also serializes against admission, revocation,
      // incoming collisions, and terminal state. Claim is persisted before egress.
      const device = await client.query('SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE', [target.deviceId]);
      if (!device.rowCount || this.stopped) return false;
      const session = await client.query("SELECT id FROM call_session WHERE id=$1 AND state='rejecting' FOR UPDATE", [sessionId]);
      if (!session.rowCount || this.stopped) return false;
      const valid = await client.query(`SELECT 1 ${validIntent} AND i.state=$1 AND i.session_id=$4 AND i.device_id=$5
        AND i.call_id=$6 AND e.payload->>'generation'=$7 AND e.payload->>'connectionId'=$8`,
        ['pending', identityEvent, identityConflictEvent, sessionId, target.deviceId, target.callId, target.generation, target.connectionId]);
      if (valid.rows.length !== 1 || this.stopped) return false;
      const changed = await client.query(`UPDATE call_reject_intent SET state='sending',attempts=attempts+1,
        lease_until=clock_timestamp()+interval '30 seconds',updated_at=now()
        WHERE session_id=$1 AND state='pending' AND expires_at>clock_timestamp()`, [sessionId]);
      return changed.rowCount === 1;
    });
  }
}
