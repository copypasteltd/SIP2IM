import type pg from 'pg';
import { transaction } from '../db/pool.js';
import { raiseAlert, resolveAlert, type AlertEvent } from '../alerts/episodes.js';

type Platform = 'qq' | 'telegram';
type ReportedState = { state: string; selfId: string | null; alias: string | null };
export type ChannelObservationOptions = { observeOutage?: boolean | 'persisted-login'; isCurrent?: () => boolean };
const STALE_CHANNEL = new Error('Channel observation is no longer current');

export class ChannelRepository { constructor(private readonly pool:pg.Pool) {} async list():Promise<unknown[]> {const r=await this.pool.query(`SELECT c.platform,c.state,c.self_id AS "selfId",c.alias,('{"login":false,"sendMessage":false,"receiveMessage":false,"dial":false,"receiveAudio":false,"sendAudio":false,"maxConcurrentCalls":0}'::jsonb || (c.capabilities-'_voipgwObservedLogin') || '{"sendMessage":false,"receiveMessage":false,"dial":false,"receiveAudio":false,"sendAudio":false,"maxConcurrentCalls":0}'::jsonb) AS capabilities,c.voice_verified AS "voiceVerified",COALESCE((SELECT value #>> '{}' FROM setting WHERE key='inbound_platform')=c.platform,false) AS "isInbound",EXISTS(SELECT 1 FROM call_session s WHERE s.platform=c.platform AND s.state<>'ended') AS busy,CASE WHEN p.id IS NULL THEN NULL ELSE json_build_object('id',p.id,'platform',p.platform,'platformUserId',p.platform_user_id,'displayName',p.display_name,'pairedAt',extract(epoch from p.paired_at)*1000) END AS "pairedUser" FROM channel c LEFT JOIN paired_user p ON p.platform=c.platform AND p.revoked_at IS NULL ORDER BY c.platform`);return r.rows;}

  adapterOffline(platform: Platform, options: ChannelObservationOptions = {}): Promise<AlertEvent | null> {
    return this.observe(platform, null, options);
  }

  adapterState(platform: Platform, state: ReportedState, options: ChannelObservationOptions = {}): Promise<AlertEvent | null> {
    return this.observe(platform, state, options);
  }

  private async observe(platform: Platform, report: ReportedState | null, options: ChannelObservationOptions): Promise<AlertEvent | null> {
    const next = report?.state ?? 'offline';
    const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw STALE_CHANNEL; };
    try {
      assertCurrent();
      return await transaction(this.pool, async client => {
        const current = await client.query<{ state: string; armed: boolean }>(
          'SELECT state, capabilities->\'_voipgwObservedLogin\'=\'true\'::jsonb AS armed FROM channel WHERE platform=$1 FOR UPDATE',
          [platform],
        );
        assertCurrent();
        const before = current.rows[0];
        if (!before) throw new Error('Channel observation has no parent row');
        const previouslyOnline = before.state === 'logged_in' || before.armed === true;
        const down = next === 'offline' || next === 'logged_out' || next === 'banned';
        // On startup the transport is only known to have been interrupted if the
        // previous process left a logged-in state. A deliberate shutdown/reset
        // retains the marker for the next authoritative report, not a new outage.
        const observeOutage = down && options.observeOutage !== false &&
          (options.observeOutage !== 'persisted-login' || before.state === 'logged_in');
        const armed = next === 'logged_in' || previouslyOnline && !observeOutage;
        const saved = await client.query(
          'UPDATE channel SET state=$2, self_id=CASE WHEN $3::boolean THEN $4::text ELSE self_id END, ' +
          'alias=CASE WHEN $3::boolean THEN $5::text ELSE alias END, ' +
          'capabilities=(CASE WHEN $3::boolean THEN capabilities-\'_voipgwObservedLogin\' ELSE \'{}\'::jsonb END) || ' +
          '(CASE WHEN $6::boolean THEN \'{"_voipgwObservedLogin":true}\'::jsonb ELSE \'{}\'::jsonb END), ' +
          'updated_at=now() WHERE platform=$1',
          [platform, next, report !== null, report?.selfId ?? null, report?.alias ?? null, armed],
        );
        if (saved.rowCount !== 1) throw new Error('Channel observation not recorded');
        assertCurrent();
        const target = { type: 'channel_down', subjectType: 'channel', subjectId: platform } as const;
        const event = next === 'logged_in' ? await resolveAlert(client, target) :
          observeOutage && previouslyOnline ? await raiseAlert(client, target) : null;
        assertCurrent();
        return event;
      });
    } catch (error) {
      // A rollback or connection failure wrapping this sentinel remains visible.
      if (error === STALE_CHANNEL) return null;
      throw error;
    }
  }

  async adapterCapabilities(platform: Platform, capabilities: unknown): Promise<void> {
    await this.pool.query(
      'UPDATE channel SET capabilities=($2::jsonb-\'_voipgwObservedLogin\') || ' +
      '(CASE WHEN capabilities->\'_voipgwObservedLogin\'=\'true\'::jsonb THEN \'{"_voipgwObservedLogin":true}\'::jsonb ELSE \'{}\'::jsonb END), ' +
      'updated_at=now() WHERE platform=$1', [platform, JSON.stringify(capabilities)],
    );
  }

 async pairedUser(platform:'qq'|'telegram'):Promise<unknown|null> {const r=await this.pool.query(`SELECT id,platform,platform_user_id AS "platformUserId",display_name AS "displayName",(extract(epoch from paired_at)*1000)::double precision AS "pairedAt" FROM paired_user WHERE platform=$1 AND revoked_at IS NULL`,[platform]);return r.rows[0]??null;} async revokePairedUser(platform:'qq'|'telegram'):Promise<void> {await transaction(this.pool,async client=>{const row=await client.query('SELECT platform FROM channel WHERE platform=$1 FOR UPDATE',[platform]);if(row.rowCount!==1) throw new Error('Unknown pairing platform');await client.query('UPDATE pairing_code SET used_at=clock_timestamp() WHERE platform=$1 AND used_at IS NULL',[platform]);await client.query("UPDATE paired_user SET revoked_at=clock_timestamp(),revoke_reason='admin' WHERE platform=$1 AND revoked_at IS NULL",[platform]);});} }
