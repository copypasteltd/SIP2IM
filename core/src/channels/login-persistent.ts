import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { AdapterAck, AdapterLoginCommand, AdapterLoginDispatch, AdapterLoginTransport, AdapterPlatform } from './adapter-manager.js';
import { knownLocalRejection, type LoginOperationResult } from './login-operations.js';

export type LoginPlatform = AdapterPlatform;
export type TerminalLoginOutcome = 'ack' | 'offline' | 'invalid';
export type LoginOperationObservation = { status: 'idle' | 'pending' | 'unknown' | 'terminal'; operationId: string | null; outcome: TerminalLoginOutcome | null };
export type LoginRecoveryEvidence = { operationId: string; platform: LoginPlatform; outcome: TerminalLoginOutcome; terminalAt: string; actor: string; recoveredAt: string };
export const loginOperationIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A reservation is conservatively unknown from its creation until definitive completion.
 * No command payload, response, error, or credentials are stored. */
export class LoginOperationRepository {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async status(platform: LoginPlatform): Promise<'idle' | 'unknown'> {
    const result = await this.pool.query('SELECT platform FROM platform_login_operation WHERE platform=$1', [platform]);
    return result.rowCount === 0 ? 'idle' : 'unknown';
  }

  async reserve(platform: LoginPlatform): Promise<string | null> {
    const token = randomUUID();
    const result = await this.pool.query(
      'INSERT INTO platform_login_operation(platform, operation_id) VALUES ($1,$2::uuid) ON CONFLICT (platform) DO NOTHING RETURNING platform',
      [platform, token]);
    return result.rowCount === 1 ? token : null;
  }

  /** Inspect the exact evidence before explicitly reconciling it. */
  async inspect(platform: LoginPlatform): Promise<{ operationId: string; outcome: 'ack' | 'offline' | 'invalid' | null } | null> {
    const result = await this.pool.query<{operation_id: string; terminal_outcome: 'ack' | 'offline' | 'invalid' | null}>(
      'SELECT operation_id, terminal_outcome FROM platform_login_operation WHERE platform=$1', [platform]);
    const row = result.rows[0];
    return row ? { operationId: row.operation_id, outcome: row.terminal_outcome } : null;
  }

  /** Read a release audit by exact operation id. Absence is an observation at
   * query time, not proof that an earlier uncertain transaction cannot commit later. */
  async inspectRecovery(operationId: string): Promise<LoginRecoveryEvidence | null> {
    if (typeof operationId !== 'string' || !loginOperationIdPattern.test(operationId)) throw new Error('invalid recovery request');
    const result = await this.pool.query<{operation_id: string; platform: LoginPlatform; terminal_outcome: 'ack' | 'offline' | 'invalid'; terminal_at: string; actor: string; recovered_at: string}>(
      'SELECT operation_id, platform, terminal_outcome, terminal_at::text, actor, recovered_at::text FROM platform_login_recovery_audit WHERE operation_id=$1::uuid', [operationId]);
    const row = result.rows[0];
    return row ? {operationId: row.operation_id, platform: row.platform, outcome: row.terminal_outcome, terminalAt: row.terminal_at, actor: row.actor, recoveredAt: row.recovered_at} : null;
  }

  /** Release exact terminal evidence and audit atomically. An error may mean the
   * statement committed. The future caller must authenticate and authorize actor. */
  async releaseTerminal(platform: LoginPlatform, operationId: string, outcome: 'ack' | 'offline' | 'invalid', actor: string): Promise<boolean> {
    if (!['qq', 'telegram'].includes(platform) || !['ack', 'offline', 'invalid'].includes(outcome) ||
        typeof operationId !== 'string' || !loginOperationIdPattern.test(operationId) ||
        typeof actor !== 'string' || !/^[A-Za-z0-9_.:@-]{1,128}$/.test(actor)) throw new Error('invalid recovery request');
    const result = await this.pool.query(
      'WITH released AS (DELETE FROM platform_login_operation WHERE platform=$1 AND operation_id=$2::uuid AND terminal_outcome=$3 AND terminal_at IS NOT NULL RETURNING platform, operation_id, terminal_outcome, terminal_at) INSERT INTO platform_login_recovery_audit(platform, operation_id, terminal_outcome, terminal_at, actor) SELECT platform, operation_id, terminal_outcome, terminal_at, $4 FROM released RETURNING operation_id',
      [platform, operationId, outcome, actor]);
    return result.rowCount === 1;
  }

  /** Persist definitive evidence without making the platform available again. Both a
   * lost reply and a failed update leave a blocking row. The operation id fences
   * late completions, and terminal evidence is never overwritten. */
  async recordTerminal(platform: LoginPlatform, token: string, outcome: 'ack' | 'offline' | 'invalid'): Promise<boolean> {
    const result = await this.pool.query(
      "UPDATE platform_login_operation SET terminal_outcome=$3, terminal_at=clock_timestamp() WHERE platform=$1 AND operation_id=$2::uuid AND terminal_outcome IS NULL",
      [platform, token, outcome]);
    return result.rowCount === 1;
  }
}

/** One durable reservation per platform. Unknown work blocks across restarts. */
export class PersistentLoginOperations {
  private readonly pending = new Set<LoginPlatform>();
  constructor(private readonly transport: AdapterLoginTransport, private readonly repository: LoginOperationRepository) {}

  async current(platform: LoginPlatform): Promise<LoginOperationObservation> {
    const row = await this.repository.inspect(platform);
    return {
      status: row?.outcome ? 'terminal' : this.pending.has(platform) ? 'pending' : row ? 'unknown' : 'idle',
      operationId: row?.operationId ?? null,
      outcome: row?.outcome ?? null,
    };
  }

  async execute(platform: LoginPlatform, type: AdapterLoginCommand, payload: unknown, assertCanReserve: () => void = () => {}): Promise<LoginOperationResult> {
    if (this.pending.has(platform)) return { kind: 'blocked' };
    this.pending.add(platform);
    try {
      let dispatch: AdapterLoginDispatch;
      try {
        assertCanReserve();
        // Bind to the current connection + challenge before any database wait.
        dispatch = this.transport.prepareLogin(platform, type, payload);
      } catch (error) {
        // Existing unknown evidence takes precedence over a local offline/unsupported report.
        if (await this.repository.inspect(platform)) return { kind: 'blocked' };
        const rejection = knownLocalRejection(error);
        return rejection ? { kind: 'rejected', code: rejection.code } : { kind: 'unknown' };
      }
      // A failed or uncertain insert must never be followed by dispatch. The
      // INSERT's unique platform key also serializes independent Core instances.
      const token = await this.repository.reserve(platform);
      if (token === null) return { kind: 'blocked' };
      return await this.dispatch(platform, dispatch, token);
    } catch {
      return { kind: 'unknown' };
    } finally {
      this.pending.delete(platform);
    }
  }

  private async dispatch(platform: LoginPlatform, send: AdapterLoginDispatch, token: string): Promise<LoginOperationResult> {
    let ack: AdapterAck;
    try {
      ack = await send(async late => {
        if (late.ok) await this.repository.recordTerminal(platform, token, 'ack');
      });
    }
    catch (error) {
      const rejection = knownLocalRejection(error);
      if (!rejection) return { kind: 'unknown' };
      const outcome = rejection.code === 'CHANNEL_UNAVAILABLE' ? 'offline' : 'invalid';
      return await this.finish(platform, token, outcome) ? { kind: 'rejected', code: rejection.code } : { kind: 'unknown' };
    }
    // Preserve a known wire error for HTTP, but never infer nonexecution from
    // a NACK. Only a positive correlated ACK is terminal on the current protocol.
    if (ack.ok && !await this.finish(platform, token, 'ack')) return { kind: 'unknown' };
    return { kind: 'ack', ack };
  }

  private async finish(platform: LoginPlatform, token: string, outcome: TerminalLoginOutcome): Promise<boolean> {
    try {
      if (!await this.repository.recordTerminal(platform, token, outcome)) return false;
      if (await this.repository.releaseTerminal(platform, token, outcome, 'core')) return true;
      // A racing authorized operator may already have consumed the exact row.
      return !!await this.recovery(platform, token, outcome);
    } catch {
      // A lost release reply can be resolved by exact durable audit evidence.
      // No evidence is not proof of rollback; leave the result unknown.
      try { return !!await this.recovery(platform, token, outcome); }
      catch { return false; }
    }
  }

  async recovery(platform: LoginPlatform, operationId: string, outcome?: TerminalLoginOutcome): Promise<LoginRecoveryEvidence | null> {
    const evidence = await this.repository.inspectRecovery(operationId);
    return evidence?.platform === platform && (outcome === undefined || evidence.outcome === outcome) ? evidence : null;
  }

  async release(platform: LoginPlatform, operationId: string, outcome: TerminalLoginOutcome, actor: string): Promise<boolean> {
    if (await this.repository.releaseTerminal(platform, operationId, outcome, actor)) return true;
    return !!await this.recovery(platform, operationId, outcome);
  }
}
