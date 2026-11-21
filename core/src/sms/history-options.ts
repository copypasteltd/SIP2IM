import type pg from 'pg';
export interface HistoryOptionFilters { q?:string; limit:number; cursor?:string; deviceId?:string }
/** Labels are mutable retained metadata, not snapshots from message time; SIM attribution reflects stored SMS data.
 * Cursors traverse a live view, not a snapshot: changes between pages can affect membership and labels.
 * Reuse a cursor only with the same endpoint and filters. SIM options omit inconsistent SMS rows
 * whose device_id differs from the referenced SIM owner, so they are not a complete inventory of such rows. */
export class SmsHistoryOptions {
  constructor(private readonly pool:pg.Pool) {}
  private async page(kind:'devices'|'sims', f:HistoryOptionFilters) {
    let after:string|null=null;
    if(f.cursor!==undefined) {
      try {
        const decoded=Buffer.from(f.cursor,'base64url').toString('utf8');
        if(!/^[A-Za-z0-9_-]+$/.test(f.cursor) || Buffer.from(decoded).toString('base64url')!==f.cursor || !/^[!-~]{1,128}$/.test(decoded)) throw new Error();
        after=decoded;
      } catch { throw new Error('BAD_CURSOR'); }
    }
    const sql=kind==='devices' ?
      'SELECT d.id,d.name,(d.revoked_at IS NOT NULL) AS revoked FROM device d WHERE EXISTS (SELECT 1 FROM sms_message m WHERE m.device_id=d.id) AND ($1::text IS NULL OR strpos(lower(d.name),lower($1))>0 OR strpos(lower(d.id),lower($1))>0) AND ($2::text IS NULL OR d.id>$2) ORDER BY d.id LIMIT $3' :
      'SELECT s.id,s.device_id AS "deviceId",s.slot,s.carrier,n.number,(s.retired_at IS NOT NULL) AS retired,(d.revoked_at IS NOT NULL) AS "deviceRevoked" FROM sim s JOIN device d ON d.id=s.device_id LEFT JOIN sim_number n ON n.sim_id=s.id WHERE EXISTS (SELECT 1 FROM sms_message m WHERE m.sim_id=s.id AND m.device_id=s.device_id) AND ($4::text IS NULL OR s.device_id=$4) AND ($1::text IS NULL OR strpos(lower(s.id),lower($1))>0 OR strpos(lower(COALESCE(s.carrier,\'\')),lower($1))>0 OR strpos(lower(COALESCE(n.number,\'\')),lower($1))>0) AND ($2::text IS NULL OR s.id>$2) ORDER BY s.id LIMIT $3';
    const args:unknown[]=[f.q??null,after,f.limit+1];
    if(kind==='sims') args.push(f.deviceId??null);
    const rows=(await this.pool.query(sql,args)).rows as {id:string}[];
    const data=rows.slice(0,f.limit);
    return {data,nextCursor:rows.length>f.limit?Buffer.from(data[data.length-1]!.id).toString('base64url'):null};
  }
  devices(f:HistoryOptionFilters) { return this.page('devices',f); }
  sims(f:HistoryOptionFilters) { return this.page('sims',f); }
}
