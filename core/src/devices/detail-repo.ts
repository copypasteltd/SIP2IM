import type pg from 'pg';
import {DeviceAdminRepository} from './admin-repo.js';
import { projectShizukuAutostart } from './shizuku-report.js';

type StatusRow = { field: string; value: unknown; observed_at: Date; received_at: Date; ttl_sec: number };
const probeNames = ['smsSend', 'smsReceive', 'dial', 'answer', 'hangup', 'dtmf', 'downlink', 'uplink', 'earlyMedia'];

function isFresh(row: StatusRow | undefined, now: number): row is StatusRow {
  if (!row) return false;
  const observed = row.observed_at.getTime();
  const received = row.received_at.getTime();
  return Number.isFinite(observed) && Number.isFinite(received) && observed >= 0 && observed <= received &&
    observed <= now && Number.isFinite(row.ttl_sec) && now <= observed + row.ttl_sec * 1000;
}

export class DeviceDetailRepository {
  constructor(private readonly pool: pg.Pool, private readonly devices: DeviceAdminRepository,
    private readonly usbDevices?: ReadonlyMap<string, string>) {}

  async get(id: string): Promise<unknown | null> {
    const device = await this.devices.get(id);
    if (!device) return null;
    const [status, events] = await Promise.all([
      this.pool.query<StatusRow>(`SELECT field,value,observed_at,received_at,ttl_sec FROM device_status
        WHERE device_id=$1 AND (field LIKE 'probe.%' OR field IN ('permissions','usbAutostart'))`, [id]),
      this.pool.query(`SELECT id,device_id AS "deviceId",type,payload,floor(extract(epoch from device_ts)*1000) AS "deviceTs",
        floor(extract(epoch from received_at)*1000) AS "receivedAt" FROM device_event
        WHERE device_id=$1 ORDER BY received_at DESC LIMIT 50`, [id]),
    ]);
    const now = Date.now();
    const fields = new Map(status.rows.map(row => [row.field, row]));
    const probes = Object.fromEntries(probeNames.map(name => {
      const row = fields.get('probe.' + name);
      return [name, isFresh(row, now) ? row.value : { result: 'untested', probedAt: 0, detail: null }];
    }));
    const permissions = fields.get('permissions');
    const usb = projectShizukuAutostart(fields.get('usbAutostart'), now);
    return { ...device, probes,
      permissions: isFresh(permissions, now) ? permissions.value : [],
      recentEvents: events.rows.map(row => ({ ...row,
        deviceTs: row.deviceTs === null ? null : Number(row.deviceTs), receivedAt: Number(row.receivedAt) })),
      usbAutostart: usb && this.usbDevices?.get(usb.serial) === id ? usb : null,
    };
  }
}
