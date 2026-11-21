import type pg from 'pg';
import { ulid } from 'ulid';
import { transaction } from '../db/pool.js';
import { identityConflictEvent, recordCellularCallIdentity } from './generation.js';
import { setCallState } from './device-events.js';
import type { CallState } from './coordinator.js';

export class CallRequestError extends Error {
  constructor(readonly code: string, readonly status = 409) { super(code); }
}

export type WebCallRequest = { key: string; simId: string; to: string; peerKind: 'short' | 'e164' };
export type WebCallIds = {
  id: string; deviceId: string; browserLegId: string; cellularLegId: string;
  callId: string; generation: string; connectionId: string;
};
export type WebCallSim = { slot: number; subId: number | null };
export type WebCallSituation = { state: CallState; legState: string; ack: string | null };
export type WebCallRecord = { id: string; simId: string; to: string; kind: string };

const authority = (current: () => boolean) => {
  if (!current()) throw new CallRequestError('CAPABILITY_UNSUPPORTED');
};

export class PgWebCallStore {
  constructor(private readonly pool: pg.Pool) {}

  async locateSim(simId: string): Promise<string | null> {
    const result = await this.pool.query<{ device_id: string }>('SELECT device_id FROM sim WHERE id=$1 AND retired_at IS NULL', [simId]);
    return result.rows[0]?.device_id ?? null;
  }

  async find(key: string, client: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'> = this.pool): Promise<WebCallRecord | null> {
    const result = await client.query<WebCallRecord>(
      'SELECT id, sim_id AS "simId", peer AS "to", kind FROM call_session WHERE idempotency_key=$1', [key],
    );
    return result.rows[0] ?? null;
  }

  async reserve(ids: WebCallIds, request: WebCallRequest, current: () => boolean): Promise<{ existing: WebCallRecord } | { sim: WebCallSim }> {
    return transaction(this.pool, async client => {
      await client.query('SET LOCAL synchronous_commit = on');
      await client.query("SELECT pg_advisory_xact_lock(198247304,hashtext($1))", [request.key]);
      const existing = await this.find(request.key, client);
      if (existing) return { existing };
      const sim = await this.readySim(client, ids.deviceId, request.simId);
      await this.expireUnarmed(client, ids.deviceId);
      const busy = await client.query(
        `SELECT 1 FROM call_session s WHERE s.device_id=$1 AND (
          s.state NOT IN ('ended','unknown') OR (s.state='unknown' AND (
            EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id) OR
            EXISTS (SELECT 1 FROM call_leg l WHERE l.session_id=s.id AND l.type='cellular' AND l.state='active')
          ))
        ) LIMIT 1`, [ids.deviceId],
      );
      if (busy.rows.length) throw new CallRequestError('DEVICE_BUSY');
      authority(current);
      await client.query(
        `INSERT INTO call_session(id,kind,idempotency_key,device_id,sim_id,peer,peer_kind,state)
         VALUES($1,'web_out',$2,$3,$4,$5,$6,'awaiting_browser')`,
        [ids.id, request.key, ids.deviceId, request.simId, request.to, request.peerKind],
      );
      await client.query(
        `INSERT INTO call_leg(id,session_id,type,state,ref_id)
         VALUES($1,$2,'browser','created',NULL),($3,$2,'cellular','created',$4)`,
        [ids.browserLegId, ids.id, ids.cellularLegId, ids.callId],
      );
      await recordCellularCallIdentity(client, { sessionId: ids.id, legId: ids.cellularLegId,
        callId: ids.callId, generation: ids.generation, connectionId: ids.connectionId });
      await this.event(client, ids.id, 'state:awaiting_browser', { reason: 'awaiting_browser_media' });
      authority(current);
      return { sim };
    });
  }

  /** A failed reserve can have committed. Waiting for the same key and device
   * locks lets us inspect only the exact unarmed reservation created by it. */
  async compensateReservation(ids: WebCallIds, key: string): Promise<void> {
    await transaction(this.pool, async client => {
      await client.query('SET LOCAL synchronous_commit = on');
      await client.query('SELECT pg_advisory_xact_lock(198247304,hashtext($1))', [key]);
      const row = await this.lock(client, ids);
      if (row?.state === 'awaiting_browser' && row.legState === 'created' && row.ack === null) {
        await this.endUnarmed(client, ids.id, 'reservation_reply_unconfirmed');
      }
    });
  }

  private async expireUnarmed(client: pg.PoolClient, deviceId: string): Promise<void> {
    const stale = await client.query<{ id: string }>(
      `SELECT s.id FROM call_session s WHERE device_id=$1 AND kind='web_out' AND state='awaiting_browser'
        AND started_at <= clock_timestamp()-interval '30 seconds'
        AND NOT EXISTS (SELECT 1 FROM call_outbound_attempt a WHERE a.session_id=s.id)
        AND EXISTS (SELECT 1 FROM call_leg l WHERE l.session_id=s.id AND l.type='cellular' AND l.state='created')
        ORDER BY s.id FOR UPDATE OF s`, [deviceId],
    );
    for (const row of stale.rows) await this.endUnarmed(client, row.id, 'browser_reservation_expired');
  }

  private async endUnarmed(client: pg.PoolClient, sessionId: string, reason: string) {
    await client.query("UPDATE call_leg SET state='ended',ended_at=clock_timestamp(),updated_at=clock_timestamp() WHERE session_id=$1 AND state='created'", [sessionId]);
    await setCallState(client, sessionId, 'awaiting_browser', 'ended', reason, null);
  }

  private async readySim(client: pg.PoolClient, deviceId: string, simId: string): Promise<WebCallSim> {
    const device = (await client.query<{ enabled: boolean; online: boolean; paused: boolean; call_enabled: boolean }>(
      'SELECT enabled,online,paused,call_enabled FROM device WHERE id=$1 AND revoked_at IS NULL FOR UPDATE', [deviceId],
    )).rows[0];
    if (!device?.online) throw new CallRequestError('DEVICE_OFFLINE');
    if (!device.enabled || device.paused) throw new CallRequestError('DEVICE_DISABLED');
    if (!device.call_enabled) throw new CallRequestError('CALL_NOT_ENABLED');
    const probes = await client.query(
      `SELECT field FROM device_status WHERE device_id=$1 AND observed_at>=to_timestamp(0)
        AND observed_at<=LEAST(received_at,clock_timestamp())
        AND observed_at+ttl_sec*interval '1 second'>=clock_timestamp()
        AND ((field='network' AND value #>> '{}' IN ('wifi','cellular'))
          OR (field='shizuku' AND value #>> '{}'='running')
          OR (field IN ('probe.downlink','probe.uplink') AND value->>'result'='ok'))`, [deviceId],
    );
    if (probes.rows.length !== 4) throw new CallRequestError('CAPABILITY_UNSUPPORTED');
    const sim = (await client.query<WebCallSim>(
      `SELECT slot,sub_id AS "subId" FROM sim WHERE id=$1 AND device_id=$2 AND retired_at IS NULL
        AND state='ready' AND last_seen_at BETWEEN clock_timestamp()-interval '2 hours' AND clock_timestamp() FOR UPDATE`,
      [simId, deviceId],
    )).rows[0];
    if (!sim) throw new CallRequestError('SIM_NOT_READY');
    return sim;
  }

  async arm(ids: WebCallIds, simId: string, sim: WebCallSim, commandId: string, current: () => boolean): Promise<boolean> {
    return transaction(this.pool, async client => {
      await client.query('SET LOCAL synchronous_commit = on');
      const present = await this.readySim(client, ids.deviceId, simId);
      if (present.slot !== sim.slot || present.subId !== sim.subId) throw new CallRequestError('SIM_NOT_READY');
      const row = await this.lock(client, ids);
      if (row?.state !== 'awaiting_browser' || row.legState !== 'created') return false;
      authority(current);
      await client.query('INSERT INTO call_outbound_attempt(session_id,device_id,call_id,command_id) VALUES($1,$2,$3,$4)',
        [ids.id, ids.deviceId, ids.callId, commandId]);
      await client.query("UPDATE call_leg SET state='connected',connected_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1", [ids.browserLegId]);
      const changed = await setCallState(client, ids.id, 'awaiting_browser', 'cell_dialing', 'browser_media_ready', null);
      if (!changed) throw new Error('Call reservation changed');
      authority(current);
      return true;
    });
  }

  async acknowledge(ids: WebCallIds, commandId: string, result: 'ok' | 'error' | 'unknown'): Promise<void> {
    await transaction(this.pool, async client => {
      await client.query('SET LOCAL synchronous_commit = on');
      const row = await this.lock(client, ids);
      if (!row) return;
      const changed = await client.query(
        `UPDATE call_outbound_attempt SET ack_state=$5,updated_at=clock_timestamp()
          WHERE session_id=$1 AND device_id=$2 AND call_id=$3 AND command_id=$4 AND ack_state='pending'`,
        [ids.id, ids.deviceId, ids.callId, commandId, result],
      );
      if (changed.rowCount !== 1) return;
      await this.event(client, ids.id, 'dial_ack_observed', { result, commandId });
      if (result !== 'ok' && row.state === 'cell_dialing') {
        await setCallState(client, ids.id, row.state, 'unknown', 'dial_outcome_unconfirmed', 'unknown');
      }
    });
  }

  async situation(ids: WebCallIds): Promise<WebCallSituation | null> {
    return this.readSituation(this.pool, ids, false);
  }

  async bridge(ids: WebCallIds, current: () => boolean): Promise<boolean> {
    return transaction(this.pool, async client => {
      await client.query('SET LOCAL synchronous_commit = on');
      const row = await this.lock(client, ids);
      if (row?.state !== 'cell_dialing' || row.legState !== 'active' || row.ack !== 'ok' || !current()) return false;
      return setCallState(client, ids.id, row.state, 'bridged', 'cell_active_and_media_ready', null);
    });
  }

  async finish(ids: WebCallIds, reason: string, control?: { type: 'call.hangup' | 'call.dtmf'; commandId: string; current: () => boolean }): Promise<boolean> {
    return transaction(this.pool, async client => {
      await client.query('SET LOCAL synchronous_commit = on');
      const row = await this.lock(client, ids);
      if (!row) return false;
      if (control) {
        if (row.state === 'ended' || row.state === 'unknown') return false;
        if (!control.current() || row.legState === 'disconnected') return false;
        if (control.type === 'call.dtmf' && (row.state !== 'bridged' || row.legState !== 'active')) return false;
        if (control.type === 'call.hangup' && !['cell_dialing', 'bridged'].includes(row.state)) return false;
        await this.event(client, ids.id, 'control_requested', { type: control.type, commandId: control.commandId });
        if (control.type === 'call.dtmf') return control.current();
        return setCallState(client, ids.id, row.state, 'ending', reason, null);
      }
      await client.query("UPDATE call_leg SET state='ended',ended_at=COALESCE(ended_at,clock_timestamp()) WHERE id=$1", [ids.browserLegId]);
      if (row.state === 'ended' || row.state === 'unknown') return false;
      const target = row.state === 'awaiting_browser' || row.legState === 'disconnected' ? 'ended' : 'unknown';
      return setCallState(client, ids.id, row.state, target, reason, target === 'ended' ? null : 'unknown');
    });
  }

  private async lock(client: pg.PoolClient, ids: WebCallIds): Promise<WebCallSituation | null> {
    await client.query('SELECT id FROM device WHERE id=$1 FOR UPDATE', [ids.deviceId]);
    return this.readSituation(client, ids, true);
  }

  private async readSituation(client: Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>, ids: WebCallIds, lock: boolean) {
    const row = await client.query<WebCallSituation>(
      `SELECT s.state,l.state AS "legState",a.ack_state AS ack
        FROM call_session s JOIN call_leg l ON l.session_id=s.id AND l.id=$3 AND l.ref_id=$4
        LEFT JOIN call_outbound_attempt a ON a.session_id=s.id AND a.device_id=s.device_id AND a.call_id=$4
        WHERE s.id=$1 AND s.device_id=$2 AND s.kind='web_out'
        AND EXISTS (SELECT 1 FROM call_event i WHERE i.session_id=s.id AND i.leg_id=l.id
          AND i.event='cellular.identity.v1' AND i.payload->>'generation'=$6 AND i.payload->>'connectionId'=$7)
        AND NOT EXISTS (
          SELECT 1 FROM call_event e WHERE e.session_id=s.id AND e.leg_id=l.id AND e.event=$5
        )` + (lock ? ' FOR UPDATE OF s,l' : ''),
      [ids.id, ids.deviceId, ids.cellularLegId, ids.callId, identityConflictEvent, ids.generation, ids.connectionId],
    );
    return row.rows[0] ?? null;
  }

  private async event(client: pg.PoolClient, sessionId: string, name: string, payload: object) {
    await client.query('INSERT INTO call_event(id,session_id,event,payload) VALUES($1,$2,$3,$4)',
      ['evt_' + ulid(), sessionId, name, JSON.stringify(payload)]);
  }
}
