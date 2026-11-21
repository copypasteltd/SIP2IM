import type pg from 'pg';

export interface DashboardDevice { id:string; online:boolean; enabled:boolean; paused:boolean; callEnabled:boolean; capabilityLevel:string|null; inCall:boolean }
export interface DashboardSim { deviceId:string; state:string; lastSeenAt?:Date|null; numberKnown:boolean; needsReview:boolean }
export interface DashboardStatus { deviceId:string; field:string; value:unknown; observedAt:Date; receivedAt:Date; ttlSec:number }
export interface DashboardChannel { platform:string; state:string; paired:boolean; voiceVerified:boolean; busy:boolean; isInbound:boolean }
export interface DashboardSnapshot { devices:DashboardDevice[]; sims:DashboardSim[]; statuses:DashboardStatus[]; channels:DashboardChannel[]; alerts:{open:number; critical:number} }

export class DashboardRepository {
  constructor(private readonly pool:pg.Pool) {}
  async snapshot():Promise<DashboardSnapshot> {
    const [devices,sims,statuses,channels,alerts]=await Promise.all([
      this.pool.query(`SELECT d.id,d.online,d.enabled,d.paused,d.call_enabled AS "callEnabled",d.capability_level AS "capabilityLevel",EXISTS(SELECT 1 FROM call_session c WHERE c.device_id=d.id AND c.state='bridged') AS "inCall" FROM device d WHERE d.revoked_at IS NULL`),
      this.pool.query(`SELECT s.device_id AS "deviceId",s.state,s.last_seen_at AS "lastSeenAt",(n.sim_id IS NOT NULL) AS "numberKnown",s.needs_review AS "needsReview" FROM sim s JOIN device d ON d.id=s.device_id LEFT JOIN sim_number n ON n.sim_id=s.id WHERE s.retired_at IS NULL AND d.revoked_at IS NULL`),
      this.pool.query(`SELECT s.device_id AS "deviceId",s.field,s.value,s.observed_at AS "observedAt",s.received_at AS "receivedAt",s.ttl_sec AS "ttlSec" FROM device_status s JOIN device d ON d.id=s.device_id WHERE d.revoked_at IS NULL AND s.field IN ('permissions','network','shizuku','probe.downlink','probe.uplink')`),
      this.pool.query(`SELECT c.platform,c.state,c.voice_verified AS "voiceVerified",EXISTS(SELECT 1 FROM paired_user p WHERE p.platform=c.platform AND p.revoked_at IS NULL) AS paired,EXISTS(SELECT 1 FROM call_session s WHERE s.platform=c.platform AND s.state<>'ended') AS busy,COALESCE((SELECT value #>> '{}' FROM setting WHERE key='inbound_platform')=c.platform,false) AS "isInbound" FROM channel c ORDER BY c.platform`),
      this.pool.query(`SELECT count(*) FILTER (WHERE state='open')::int AS open,count(*) FILTER (WHERE state='open' AND severity='critical')::int AS critical FROM alert`)
    ]);
    return {devices:devices.rows as DashboardDevice[],sims:sims.rows as DashboardSim[],statuses:statuses.rows as DashboardStatus[],channels:channels.rows as DashboardChannel[],alerts:alerts.rows[0] as DashboardSnapshot['alerts']};
  }
}
