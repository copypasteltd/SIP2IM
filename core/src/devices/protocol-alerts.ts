import type pg from 'pg';
import { raiseAlert, resolveAlert, type AlertEvent, type AlertTarget } from '../alerts/episodes.js';
import { transaction } from '../db/pool.js';

export interface DeviceProtocolObservation {
  kind: 'mismatch' | 'compatible';
  deviceId: string;
  credentialHash: Buffer;
  isCurrent(): boolean;
}

export interface DeviceProtocolAlertObserver {
  observe(observation: DeviceProtocolObservation): Promise<void>;
}

export class DeviceProtocolAlerts implements DeviceProtocolAlertObserver {
  constructor(
    private readonly pool: pg.Pool,
    private readonly assertAdmission: () => void,
    private readonly publish: (type: AlertEvent['type'], data: unknown) => void | Promise<void>,
  ) {}

  async observe({ kind, deviceId, credentialHash, isCurrent }: DeviceProtocolObservation): Promise<void> {
    if (!isCurrent()) return;
    this.assertAdmission();
    const event = await transaction(this.pool, async client => {
      if (!isCurrent()) return null;
      // Observations must not wait behind ordinary device work indefinitely.
      await client.query("SET LOCAL lock_timeout = '500ms'");
      const device = await client.query(
        'SELECT id FROM device WHERE id=$1 AND enabled=true AND revoked_at IS NULL FOR UPDATE', [deviceId],
      );
      if (device.rowCount !== 1 || !isCurrent()) return null;
      this.assertAdmission();
      // Match the exact credential, locking device before credential just as revocation does.
      const credential = await client.query(
        'SELECT 1 FROM device_credential WHERE device_id=$1 AND token_hash=$2 AND revoked_at IS NULL FOR UPDATE',
        [deviceId, credentialHash],
      );
      if (credential.rowCount !== 1 || !isCurrent()) return null;
      this.assertAdmission();
      const target: AlertTarget = { type: 'protocol_mismatch', subjectType: 'device', subjectId: deviceId };
      const changed = await (kind === 'mismatch' ? raiseAlert(client, target) : resolveAlert(client, target));
      // Losing local ownership while a statement was pending must not commit that write.
      if (!isCurrent()) throw new Error('Protocol alert observation is no longer current');
      this.assertAdmission();
      return changed;
    });
    if (event) await this.publish(event.type, event.data);
  }
}
