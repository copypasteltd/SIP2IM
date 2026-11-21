import type pg from 'pg';
import { ulid } from 'ulid';
import { transaction } from '../db/pool.js';

const PAGE_SIZE = 24;
const PAGES_PER_TICK = 4;
const WARNING_DELAY_MS = 60_000;
const MAX_SAMPLE_GAP_MS = 30_000;
const SIM_FRESH_MS = 2 * 60 * 60 * 1000;
const HEARTBEAT_FRESH_MS = 90_000;
const PERMISSIONS_FRESH_MS = 24 * 60 * 60 * 1000;

export type DeviceHealthAlert = 'device_offline' | 'shizuku_stopped' | 'sim_not_ready' | 'sms_permission_missing';
type Belief = 'bad' | 'clear' | 'unknown';
export interface HealthDevice {
  id: string;
  enabled: boolean;
  revoked: boolean;
  online: boolean;
  call_enabled: boolean;
  last_seen_at: Date | null;
}
export interface HealthStatus {
  device_id: string;
  field: string;
  value: unknown;
  observed_at: Date;
  received_at: Date;
  ttl_sec: number;
}
export interface HealthSim {
  id: string;
  device_id: string;
  state: string;
  retired: boolean;
  last_seen_at: Date;
}
interface Finding {
  type: DeviceHealthAlert;
  subject_type: 'device' | 'sim';
  subject_id: string;
  belief: Belief;
  evidence_at: Date | null;
  delay: boolean;
}
interface Window { since: number; sampled: number }
export type DeviceHealthAlertEvent = { type: 'alert.raised' | 'alert.resolved'; data: unknown };

function observedAt(date: Date | null, now: number): number | null {
  const at = date?.getTime();
  return at !== undefined && Number.isFinite(at) && at >= 0 && at <= now ? at : null;
}

function validObservation(row: HealthStatus | undefined, now: number, maxAge: number): row is HealthStatus {
  if (!row || !Number.isInteger(row.ttl_sec) || row.ttl_sec <= 0) return false;
  const at = observedAt(row.observed_at, now);
  const received = observedAt(row.received_at, now);
  return at !== null && received !== null && at <= received && now - at <= Math.min(maxAge, row.ttl_sec * 1000);
}

function permissionBelief(value: unknown): Belief {
  if (!Array.isArray(value)) return 'unknown';
  const results = ['SEND_SMS', 'RECEIVE_SMS'].map(name => {
    const observations = value.filter((item: unknown) => !!item && typeof item === 'object' &&
      'name' in item && (item.name === name || item.name === 'android.permission.' + name));
    // An omitted or contradictory entry is not evidence of a missing permission.
    if (!observations.length) return undefined;
    const values = observations.map(item => 'granted' in item ? item.granted : undefined);
    const granted: unknown = values[0];
    return typeof granted === 'boolean' && values.every(value => value === granted) ? granted : undefined;
  });
  return results.includes(false) ? 'bad' : results.every(value => value === true) ? 'clear' : 'unknown';
}

/** Read only existing persisted observations: an unobserved value can neither start nor clear an alert. */
export function assessDeviceHealth(device: HealthDevice, statuses: ReadonlyArray<HealthStatus>,
  sims: ReadonlyArray<HealthSim>, now: number, offlineAfterSec: number): Finding[] {
  const managed = device.enabled && !device.revoked;
  const lastSeen = observedAt(device.last_seen_at, now);
  const deadline = lastSeen === null ? null : lastSeen + offlineAfterSec * 1000;
  const pastTimeout = deadline !== null && now > deadline;
  const reachable = managed && device.online && lastSeen !== null && !pastTimeout;
  const offlineBelief: Belief = !managed || reachable ? 'clear' : !device.online && pastTimeout ? 'bad' : 'unknown';
  const shizuku = statuses.find(row => row.device_id === device.id && row.field === 'shizuku');
  const permissions = statuses.find(row => row.device_id === device.id && row.field === 'permissions');
  const freshShizuku = reachable && validObservation(shizuku, now, HEARTBEAT_FRESH_MS) ? shizuku : undefined;
  const freshPermissions = reachable && validObservation(permissions, now, PERMISSIONS_FRESH_MS) ? permissions : undefined;
  const shizukuBelief: Belief = !managed || !device.call_enabled ? 'clear' :
    freshShizuku?.value === 'running' ? 'clear' :
    freshShizuku?.value === 'stopped' || freshShizuku?.value === 'not_installed' || freshShizuku?.value === 'unsupported'
      ? 'bad' : 'unknown';
  return [
    { type: 'device_offline', subject_type: 'device', subject_id: device.id, delay: false,
      // The outage begins at timeout. Its preceding heartbeat can predate the
      // recovery scan that closed the previous outage.
      belief: offlineBelief, evidence_at: offlineBelief === 'bad' && deadline !== null ? new Date(deadline) : device.last_seen_at },
    { type: 'shizuku_stopped', subject_type: 'device', subject_id: device.id, delay: true,
      belief: shizukuBelief, evidence_at: freshShizuku?.observed_at ?? null },
    { type: 'sms_permission_missing', subject_type: 'device', subject_id: device.id, delay: false,
      belief: !managed ? 'clear' : permissionBelief(freshPermissions?.value), evidence_at: freshPermissions?.observed_at ?? null },
    ...sims.filter(sim => sim.device_id === device.id).map((sim): Finding => {
      const at = observedAt(sim.last_seen_at, now);
      const fresh = reachable && at !== null && now - at <= SIM_FRESH_MS;
      return { type: 'sim_not_ready', subject_type: 'sim', subject_id: sim.id, delay: true,
        belief: !managed || sim.retired ? 'clear' : !fresh ? 'unknown' :
          sim.state === 'ready' ? 'clear' : sim.state === 'absent' || sim.state === 'locked' ? 'bad' : 'unknown',
        evidence_at: fresh ? sim.last_seen_at : null };
    }),
  ];
}

/** Restart/unknown/sample gaps reset debounce, not previously persisted alert history. */
export function qualifyFindings(findings: ReadonlyArray<Finding>, previous: ReadonlyMap<string, Window>, now: number) {
  const windows = new Map([...previous].filter(([, sample]) => now >= sample.sampled && now - sample.sampled <= MAX_SAMPLE_GAP_MS));
  const ready: Finding[] = [];
  for (const finding of findings) {
    const key = finding.type + ':' + finding.subject_id;
    if (finding.belief !== 'bad' || !finding.delay) {
      windows.delete(key);
      if (finding.belief !== 'unknown') ready.push(finding);
      continue;
    }
    const since = windows.get(key)?.since ?? now;
    windows.set(key, { since, sampled: now });
    if (now - since >= WARNING_DELAY_MS) ready.push(finding);
  }
  return { ready, windows };
}

const targetRows = 'jsonb_to_recordset($1::jsonb) AS t(type text, subject_type text, subject_id text)';
const columns = 'a.id,a.type,a.subject_type AS "subjectType",a.subject_id AS "subjectId",a.severity,a.state,a.detail,' +
  'floor(extract(epoch from a.first_at)*1000)::double precision AS "firstAt",' +
  'floor(extract(epoch from a.last_at)*1000)::double precision AS "lastAt",' +
  'floor(extract(epoch from a.pushed_at)*1000)::double precision AS "pushedAt",' +
  'floor(extract(epoch from a.resolved_at)*1000)::double precision AS "resolvedAt"';
const sameTarget = 'a.type=t.type AND a.subject_type=t.subject_type AND a.subject_id=t.subject_id';
const live = "a.state IN ('open','acked') AND a.resolved_at IS NULL";

async function persist(client: pg.PoolClient, findings: ReadonlyArray<Finding>, now: Date): Promise<DeviceHealthAlertEvent[]> {
  const events: DeviceHealthAlertEvent[] = [];
  const clear = findings.filter(row => row.belief === 'clear');
  if (clear.length) {
    // Acknowledgement suppresses noise; only this observed recovery closes
    // the health episode. Keep acked rows in their original history filter.
    const result = await client.query("UPDATE alert AS a SET state=CASE WHEN a.state='open' THEN 'resolved' ELSE a.state END," +
      ' resolved_at=GREATEST(a.last_at,a.first_at,$2::timestamptz) FROM ' + targetRows +
      ' WHERE ' + sameTarget + ' AND ' + live + ' RETURNING ' + columns, [JSON.stringify(clear), now]);
    events.push(...result.rows.map(data => ({ type: 'alert.resolved' as const, data })));
  }
  const bad = findings.filter(row => row.belief === 'bad').map(row => ({ ...row, id: 'alr_' + ulid() }));
  if (bad.length) {
    const result = await client.query(
      'INSERT INTO alert AS a (id,type,subject_type,subject_id,severity,state,detail,first_at,last_at) ' +
      "SELECT t.id,t.type,t.subject_type,t.subject_id,'warning','open','{}'::jsonb,$2::timestamptz,$2::timestamptz " +
      'FROM jsonb_to_recordset($1::jsonb) AS t(id text,type text,subject_type text,subject_id text,evidence_at timestamptz) ' +
      // A fresh unhealthy sample in the same episode cannot undo an acknowledgement.
      'WHERE t.evidence_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM alert a WHERE ' + sameTarget +
      ' AND ((' + live + ') OR a.resolved_at>=t.evidence_at)) ' +
      "ON CONFLICT (type,subject_id) WHERE state='open' DO NOTHING RETURNING " + columns, [JSON.stringify(bad), now]);
    events.push(...result.rows.map(data => ({ type: 'alert.raised' as const, data })));
    // Duplicate samples never rewrite alert rows or repeatedly publish a transition.
    await client.query('UPDATE alert AS a SET last_at=t.evidence_at FROM ' +
      'jsonb_to_recordset($1::jsonb) AS t(type text,subject_type text,subject_id text,evidence_at timestamptz)' +
      " WHERE " + sameTarget + " AND a.state='open' AND a.resolved_at IS NULL AND t.evidence_at > a.last_at", [JSON.stringify(bad)]);
  }
  return events;
}

/** Only Core's single-flight health timer calls this reconciler. Existing device
 * writers lock the same device row before updating heartbeat/snapshot evidence. */
export class DeviceHealthAlerts {
  private cursor: string | null = null;
  private windows = new Map<string, Window>();

  constructor(private readonly pool: pg.Pool) {}

  async sweep(offlineAfterSec: number, assertAdmission: () => void,
    publish: (type: DeviceHealthAlertEvent['type'], data: unknown) => Promise<void>): Promise<void> {
    if (!Number.isSafeInteger(offlineAfterSec) || offlineAfterSec <= 0) throw new Error('Invalid device health timeout');
    const notificationFailures: unknown[] = [];
    for (let i = 0; i < PAGES_PER_TICK; i++) {
      assertAdmission();
      const page = await transaction(this.pool, async client => {
        await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        const { rows: devices } = await client.query<HealthDevice>(
          'SELECT d.id,d.enabled,d.revoked_at IS NOT NULL AS revoked,d.online,d.call_enabled,d.last_seen_at ' +
          'FROM device d WHERE ($1::text IS NULL OR d.id>$1) AND ((d.enabled AND d.revoked_at IS NULL) ' +
          "OR EXISTS (SELECT 1 FROM alert a WHERE " + live + " AND ((a.type IN ('device_offline','shizuku_stopped','sms_permission_missing') " +
          "AND a.subject_type='device' AND a.subject_id=d.id) OR (a.type='sim_not_ready' AND a.subject_type='sim' " +
          'AND EXISTS (SELECT 1 FROM sim s WHERE s.id=a.subject_id AND s.device_id=d.id))))) ' +
          'ORDER BY d.id LIMIT $2 FOR UPDATE OF d SKIP LOCKED',
          [this.cursor, PAGE_SIZE],
        );
        assertAdmission();
        if (!devices.length) return null;
        const lookup = [devices.map(device => device.id)];
        const { rows: statuses } = await client.query<HealthStatus>(
          "SELECT device_id,field,value,observed_at,received_at,ttl_sec FROM device_status WHERE device_id=ANY($1::text[]) AND field IN ('shizuku','permissions')", lookup,
        );
        const { rows: sims } = await client.query<HealthSim>(
          'SELECT s.id,s.device_id,s.state,s.retired_at IS NOT NULL AS retired,s.last_seen_at FROM sim s WHERE s.device_id=ANY($1::text[]) ' +
          "AND (s.retired_at IS NULL OR EXISTS (SELECT 1 FROM alert a WHERE a.type='sim_not_ready' AND a.subject_type='sim' AND a.subject_id=s.id AND " + live + '))', lookup,
        );
        const clock = await client.query<{ at: Date }>('SELECT clock_timestamp() AS at');
        const at = clock.rows[0]?.at;
        if (!at || !Number.isFinite(at.getTime())) throw new Error('Health alert clock unavailable');
        const observed = devices.flatMap(device => assessDeviceHealth(device, statuses, sims, at.getTime(), offlineAfterSec));
        const qualified = qualifyFindings(observed, this.windows, at.getTime());
        assertAdmission();
        const events = await persist(client, qualified.ready, at);
        assertAdmission();
        return { ...qualified, events, tail: devices.length < PAGE_SIZE ? null : devices.at(-1)!.id };
      });
      if (!page) { this.cursor = null; break; }
      this.windows = page.windows;
      this.cursor = page.tail;
      for (const event of page.events) {
        assertAdmission();
        try { await publish(event.type, event.data); } catch (error) { notificationFailures.push(error); }
      }
      if (page.tail === null) break;
    }
    if (notificationFailures.length) throw new AggregateError(notificationFailures, 'Health alert notifications could not be published');
  }
}
