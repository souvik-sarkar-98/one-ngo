import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Database } from '@onengo/platform/operator';
import { OPERATOR_ACTIONS, OPERATOR_STEP_UP_ACTIONS, type OperatorActionContract, type OperatorStepUpActionContract } from '@onengo/platform/contracts';
import type { SqlExecutor } from '@onengo/kernel/db';

export const SESSION_COOKIE = '__Host-ngo_operator';
export const ACTIONS: readonly OperatorActionContract[] = OPERATOR_ACTIONS;
export const STEP_UP_ACTIONS: readonly OperatorStepUpActionContract[] = OPERATOR_STEP_UP_ACTIONS;
export const digest = (value: string): string => createHash('sha256').update(value).digest('hex');
export const opaque = (bytes = 32): string => randomBytes(bytes).toString('base64url');
export const canonicalTarget = (value: string): string => value.trim().toLowerCase();

export class SecretBox {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('OPERATOR_ENCRYPTION_KEY must decode to 32 bytes.');
  }
  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
  }
  open<T>(encoded: string): T {
    const bytes = Buffer.from(encoded, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    decipher.setAuthTag(bytes.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString()) as T;
  }
}

export interface LoginState {
  state: string;
  nonce: string;
  verifier: string;
  nextPath: string;
  stepUp?: { sessionId: string; action: OperatorStepUpActionContract; target: string };
}
export interface Session {
  id: string;
  token: string;
  operatorId: string;
  issuer: string;
  subject: string;
  display: string;
  authTime: string;
  amr: string[];
  acr?: string;
  actions: OperatorActionContract[];
  csrf: string;
}

export class OperatorStore {
  constructor(private readonly db: Database, private readonly box: SecretBox) {}
  private tx<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> { return this.db.asSystem(fn); }

  async saveLogin(input: LoginState, issuer: string, ttlSeconds = 600): Promise<void> {
    await this.tx(async (tx) => {
      await tx.query(
        `insert into operator_login_state(id_hash,issuer,nonce_hash,verifier_ciphertext,next_path,expires_at)
         values($1,$2,$3,$4,$5,now()+($6||' seconds')::interval)`,
        [digest(input.state), issuer, digest(input.nonce), this.box.seal(input), input.nextPath, ttlSeconds],
      );
    });
  }

  async consumeLogin(state: string): Promise<LoginState | undefined> {
    return this.tx(async (tx) => {
      const rows = await tx.query<{ verifier_ciphertext: string }>(
        `update operator_login_state set consumed_at=now() where id_hash=$1 and consumed_at is null and expires_at>now()
         returning verifier_ciphertext`, [digest(state)],
      );
      return rows[0] ? this.box.open<LoginState>(rows[0].verifier_ciphertext) : undefined;
    });
  }

  async createSession(identity: {
    issuer: string; subject: string; display: string; authTime: number; amr: string[]; acr?: string; sid?: string; provider: unknown;
  }): Promise<Session | undefined> {
    return this.tx(async (tx) => {
      const account = (await tx.query<{ id: string; display_name: string }>(
        `select a.id,a.display_name from operator_identity i join operator_account a on a.id=i.operator_id
         where i.issuer=$1 and i.subject=$2 and a.status='active'`, [identity.issuer, identity.subject],
      ))[0];
      if (!account) return undefined;
      const grants = await this.grants(tx, account.id);
      const token = opaque();
      const csrf = opaque();
      const id = randomUUID();
      await tx.query(
        `insert into operator_session(id,token_hash,operator_id,issuer,subject,provider_sid,display_snapshot,auth_time,amr,acr,provider_tokens_ciphertext,expires_at)
         values($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9,$10,$11,now()+interval '8 hours')`,
        [id, digest(token), account.id, identity.issuer, identity.subject, identity.sid ?? null, account.display_name,
          identity.authTime, identity.amr, identity.acr ?? null, this.box.seal({ provider: identity.provider, csrf })],
      );
      return { id, token, operatorId: account.id, issuer: identity.issuer, subject: identity.subject,
        display: account.display_name, authTime: new Date(identity.authTime * 1000).toISOString(), amr: identity.amr,
        acr: identity.acr, actions: grants, csrf };
    });
  }

  async session(token: string): Promise<Session | undefined> {
    return this.tx(async (tx) => {
      const row = (await tx.query<{
        id: string; operator_id: string; issuer: string; subject: string; display_snapshot: string; auth_time: Date;
        amr: string[]; acr: string | null; provider_tokens_ciphertext: string; status: string;
      }>(`select s.*,a.status from operator_session s join operator_account a on a.id=s.operator_id
          where s.token_hash=$1 and s.revoked_at is null and s.expires_at>now() for update`, [digest(token)]))[0];
      if (!row || row.status !== 'active') return undefined;
      const material = this.box.open<{ csrf: string }>(row.provider_tokens_ciphertext);
      return { id: row.id, token, operatorId: row.operator_id, issuer: row.issuer, subject: row.subject,
        display: row.display_snapshot, authTime: row.auth_time.toISOString(), amr: row.amr, acr: row.acr ?? undefined,
        actions: await this.grants(tx, row.operator_id), csrf: material.csrf };
    });
  }

  private async grants(tx: SqlExecutor, operatorId: string): Promise<OperatorActionContract[]> {
    const rows = await tx.query<{ action: OperatorActionContract }>(
      'select action from operator_grant where operator_id=$1 and revoked_at is null', [operatorId],
    );
    return rows.map((row) => row.action).filter((action) => ACTIONS.includes(action));
  }

  async rotate(token: string): Promise<string | undefined> {
    return this.tx(async (tx) => {
      const next = opaque();
      const rows = await tx.query<{ id: string }>(
        `update operator_session set token_hash=$2,rotated_at=now() where token_hash=$1 and revoked_at is null and expires_at>now()
         returning id`, [digest(token), digest(next)],
      );
      return rows[0] ? next : undefined;
    });
  }
  async revoke(token: string): Promise<void> {
    await this.tx((tx) => tx.query('update operator_session set revoked_at=coalesce(revoked_at,now()) where token_hash=$1', [digest(token)]).then(() => undefined));
  }
  async revokeSid(issuer: string, sid: string): Promise<void> {
    await this.tx((tx) => tx.query('update operator_session set revoked_at=coalesce(revoked_at,now()) where issuer=$1 and provider_sid=$2', [issuer, sid]).then(() => undefined));
  }

  async createStepUp(sessionId: string, action: OperatorStepUpActionContract, target: string, authTime: number, amr: string[]): Promise<string> {
    return this.tx(async (tx) => {
      const id = randomUUID();
      await tx.query(`insert into operator_step_up(id,session_id,action,target,nonce_hash,auth_time,amr,expires_at)
        values($1,$2,$3,$4,$5,to_timestamp($6),$7,now()+interval '5 minutes')`,
      [id, sessionId, action, canonicalTarget(target), digest(opaque()), authTime, amr]);
      return id;
    });
  }

  async consumeStepUp(id: string, sessionId: string, action: OperatorStepUpActionContract, target: string): Promise<boolean> {
    return this.tx(async (tx) => {
      const result = await tx.queryWithRowCount(
        `update operator_step_up set used_at=now() where id=$1 and session_id=$2 and action=$3 and target=$4
         and used_at is null and expires_at>now() and auth_time>now()-interval '5 minutes' and 'mfa'=any(amr)`,
        [id, sessionId, action, canonicalTarget(target)],
      );
      return result.affectedRows === 1;
    });
  }
}
