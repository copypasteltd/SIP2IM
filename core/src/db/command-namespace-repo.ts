import type pg from 'pg';

export interface CommandReservation {
  commandId: string;
  commandType: string;
  ownerType: string;
  ownerId: string;
  deviceId: string;
}

/**
 * Unwired primitive: use the caller's transaction to reserve alongside its attempt.
 * A reservation is not permission to transmit and does not establish a device
 * registration generation. No legacy IDs have been imported. Existing SMS and
 * call attempts and unpersisted DeviceCommands, hello.ok and ACK IDs are not
 * fenced here. Every allocator must participate and legacy collisions must be
 * inventoried and quarantined or reconciled before integration. A conflict always
 * fails closed, even for an identical tuple; uncertain commits must be reconciled
 * before any future transmission, never blindly retried or interpreted as success.
 */
export class CommandNamespaceRepository {
  constructor(private readonly client: Pick<pg.PoolClient, 'query'>) {}

  async reserve(input: CommandReservation): Promise<boolean> {
    if ([input.commandId, input.commandType, input.ownerType, input.ownerId, input.deviceId].some(value => typeof value !== 'string' || value.length === 0)) {
      throw new Error('Reservation fields must be nonempty strings');
    }
    const result = await this.client.query(
      'INSERT INTO command_namespace_reservation(command_id,command_type,owner_type,owner_id,device_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (command_id) DO NOTHING RETURNING command_id',
      [input.commandId, input.commandType, input.ownerType, input.ownerId, input.deviceId],
    );
    return result.rowCount === 1;
  }

  /** Exact tuple lookup is evidence only, not an authorization or retry decision. */
  async matches(input: CommandReservation): Promise<boolean> {
    if ([input.commandId, input.commandType, input.ownerType, input.ownerId, input.deviceId].some(value => typeof value !== 'string' || value.length === 0)) {
      throw new Error('Reservation fields must be nonempty strings');
    }
    const result = await this.client.query(
      'SELECT command_id FROM command_namespace_reservation WHERE command_id=$1 AND command_type=$2 AND owner_type=$3 AND owner_id=$4 AND device_id=$5',
      [input.commandId, input.commandType, input.ownerType, input.ownerId, input.deviceId],
    );
    return result.rowCount === 1;
  }
}
