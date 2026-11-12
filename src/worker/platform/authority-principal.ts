import type { SqlValue } from './db.ts';

export type Mode = 'live' | 'test';
export type GrantScope = 'org' | 'org_mode' | 'platform';

/**
 * How a membership principal proves it is still acting. A synchronous request carries its session,
 * which must be live. Deferred work (queued mail, a scheduled broadcast) has no session by design
 * (Rule 4): it carries the org `access_revision` captured when it was queued.
 */
export type MembershipLiveness =
  | { via: 'session'; sessionIdHash: string; orgAccessRevision?: number }
  | {
      via: 'deferred';
      orgAccessRevision: number;
      /** The user's `access_revision` when the work was queued: a disable and re-enable cancels it. */
      userAccessRevision: number;
      /**
       * Deferred principals are for queue, cron and workflow code (a job context). A request context
       * names this flag to hold one, for work that outlives its session by design.
       */
      allowRequestContext?: true;
    };

/**
 * How a pass holder proves itself, evaluated in SQL against the pass row at commit. The org and mode are the
 * pass row's own. `session`: the live session of the current owner (self-remove). `verified_email`: an active
 * user who verified the pass's holder email, for a pass with no owner (attach). `device`: the credential
 * snapshot the serial resolved to (Apple personalize).
 */
export type HolderProof =
  | { via: 'session'; userId: string; sessionIdHash: string }
  | { via: 'verified_email'; userId: string }
  | {
      via: 'device';
      identityId: string;
      serial: string;
      authToken: string;
      credentialGeneration: number;
    };

/** Who acts. Ids come from the authenticated principal, never from the request body. */
export type Principal =
  | ({ kind: 'membership'; membershipId: string; mode?: Mode } & MembershipLiveness)
  | {
      kind: 'api_key';
      keyId: string;
      /** The scope this grant needs; the key must list it (`passes:write`). */
      scope: string;
      orgAccessRevision?: number;
      orgId?: string;
    }
  | { kind: 'scanner'; scannerId: string; credentialEpoch: number }
  | { kind: 'holder'; passId: string; proof: HolderProof }
  | { kind: 'platform'; userId: string; sessionIdHash: string; orgId?: string; mode?: Mode }
  | { kind: 'system'; job: string; orgId?: string; mode?: Mode; orgAccessRevision?: number };

export type HolderPrincipal = Extract<Principal, { kind: 'holder' }>;

/** Positional parameters collected in the order their `?` appear in the SQL text. */
export class Binds {
  readonly params: SqlValue[] = [];
  bind(value: SqlValue): string {
    this.params.push(value);
    return '?';
  }
}

export function principalLabel(p: Principal): string {
  switch (p.kind) {
    case 'membership':
      return `membership:${p.membershipId}`;
    case 'api_key':
      return `api_key:${p.keyId}`;
    case 'scanner':
      return `scanner:${p.scannerId}`;
    case 'holder':
      return p.proof.via === 'device' ? `device:${p.passId}` : `holder:${p.proof.userId}`;
    case 'platform':
      return `platform:${p.userId}`;
    case 'system':
      return `system:${p.job}`;
  }
}

const flag = (cond: string) => `CASE WHEN ${cond} THEN 1 ELSE 0 END`;

const adminSession = (b: Binds, now: number, idHash: string, userId: string) =>
  `EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.id_hash = ${b.bind(idHash)} AND s.user_id = ${b.bind(userId)} AND u.status = 'active'
      AND s.revoked_at IS NULL AND s.expires_at > ${b.bind(now)} AND s.idle_expires_at > ${b.bind(now)}
      AND json_type(s.roles) = 'array'
      AND EXISTS (SELECT 1 FROM json_each(s.roles) r WHERE r.type = 'text' AND r.value = 'admin'))`;

/**
 * Work queued by the pre-0052 Worker persisted `orgs.updated_at` (milliseconds) as its org revision. It can
 * never equal an `access_revision`, so it is accepted on org status alone. Remove one release after cutover.
 */
export const LEGACY_REVISION_MS = 1e12;

const orgOk = (b: Binds, revision: number | undefined) =>
  revision === undefined || revision >= LEGACY_REVISION_MS
    ? `o.status = 'active'`
    : `o.status = 'active' AND o.access_revision = ${b.bind(revision)}`;

function holderProof(proof: HolderProof, now: number, b: Binds): string {
  switch (proof.via) {
    case 'session':
      return `p.owner_user_id = ${b.bind(proof.userId)} AND EXISTS (SELECT 1 FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id_hash = ${b.bind(proof.sessionIdHash)} AND s.user_id = p.owner_user_id AND u.status = 'active'
          AND s.revoked_at IS NULL AND s.expires_at > ${b.bind(now)} AND s.idle_expires_at > ${b.bind(now)})`;
    case 'verified_email':
      return `p.owner_user_id IS NULL AND p.status = 'active' AND p.removed_at IS NULL
        AND EXISTS (SELECT 1 FROM users u JOIN user_emails e ON e.user_id = u.id
          WHERE u.id = ${b.bind(proof.userId)} AND u.status = 'active' AND e.email = p.holder_email)
        AND NOT EXISTS (SELECT 1 FROM pass_attach_blocks blk WHERE blk.pass_id = p.id AND blk.user_id = ${b.bind(proof.userId)})`;
    case 'device':
      return `p.identity_id = ${b.bind(proof.identityId)} AND p.serial = ${b.bind(proof.serial)}
        AND p.auth_token = ${b.bind(proof.authToken)} AND p.credential_generation = ${b.bind(proof.credentialGeneration)}
        AND p.status = 'active'`;
  }
}

/**
 * The CTE body that resolves a principal to `org_id, mode, actor_ok, org_ok`. It returns no row when
 * the principal or its org target is missing. The org and mode always come from a row the check
 * joins (membership, key, scanner, or the org target of a platform or system actor).
 */
export function actorSql(p: Principal, now: number, b: Binds): string {
  switch (p.kind) {
    case 'membership': {
      const mode = b.bind(p.mode ?? null);
      const session =
        p.via === 'session'
          ? ` AND EXISTS (SELECT 1 FROM sessions s WHERE s.id_hash = ${b.bind(p.sessionIdHash)}
            AND s.user_id = m.user_id AND s.revoked_at IS NULL AND s.expires_at > ${b.bind(now)}
            AND s.idle_expires_at > ${b.bind(now)})`
          : '';
      const userEpoch =
        p.via === 'deferred' ? ` AND u.access_revision = ${b.bind(p.userAccessRevision)}` : '';
      const org = orgOk(b, p.orgAccessRevision);
      return `SELECT m.org_id AS org_id, ${mode} AS mode,
        ${flag(`m.revoked_at IS NULL AND u.status = 'active'${session}${userEpoch}`)} AS actor_ok,
        ${flag(org)} AS org_ok
        FROM org_memberships m JOIN users u ON u.id = m.user_id JOIN orgs o ON o.id = m.org_id
        WHERE m.id = ${b.bind(p.membershipId)}`;
    }
    case 'api_key': {
      // A key with no org (platform key) may name the org it acts on; an org-bound key may only name its own.
      const named = p.orgId ?? null;
      const orgCol = `COALESCE(k.org_id, ${b.bind(named)})`;
      const live = `k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ${b.bind(now)})
        AND (k.org_id IS NULL OR ${b.bind(named)} IS NULL OR k.org_id = ${b.bind(named)})
        AND EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = ${b.bind(p.scope)})`;
      const orgNone = `COALESCE(k.org_id, ${b.bind(named)}) IS NULL`;
      const org = orgOk(b, p.orgAccessRevision);
      return `SELECT ${orgCol} AS org_id, k.mode AS mode, ${flag(live)} AS actor_ok,
        ${flag(`${orgNone} OR (${org})`)} AS org_ok
        FROM api_keys k LEFT JOIN orgs o ON o.id = COALESCE(k.org_id, ${b.bind(named)}) WHERE k.id = ${b.bind(p.keyId)}`;
    }
    case 'scanner': {
      const live = `sc.revoked_at IS NULL AND (sc.expires_at IS NULL OR sc.expires_at > ${b.bind(now)})
        AND sc.credential_epoch = ${b.bind(p.credentialEpoch)}`;
      return `SELECT sc.org_id AS org_id, sc.mode AS mode, ${flag(live)} AS actor_ok,
        ${flag(`o.status = 'active'`)} AS org_ok
        FROM scanners sc JOIN orgs o ON o.id = sc.org_id WHERE sc.id = ${b.bind(p.scannerId)}`;
    }
    case 'holder': {
      const live = `${holderProof(p.proof, now, b)} AND p.deleted_at IS NULL AND p.test_data_quarantined = 0`;
      return `SELECT p.org_id AS org_id, p.mode AS mode, ${flag(live)} AS actor_ok,
        ${flag(`o.status = 'active'`)} AS org_ok
        FROM passes p JOIN orgs o ON o.id = p.org_id WHERE p.id = ${b.bind(p.passId)}`;
    }
    case 'platform':
    case 'system': {
      const mode = b.bind(p.mode ?? null);
      const actor =
        p.kind === 'platform' ? adminSession(b, now, p.sessionIdHash, p.userId) : '1 = 1';
      // A platform or system principal that names an org acts on it only while the org is active.
      if (p.orgId === undefined)
        return `SELECT NULL AS org_id, ${mode} AS mode, ${flag(actor)} AS actor_ok, 1 AS org_ok`;
      const org = orgOk(b, p.kind === 'system' ? p.orgAccessRevision : undefined);
      return `SELECT o.id AS org_id, ${mode} AS mode, ${flag(actor)} AS actor_ok, ${flag(org)} AS org_ok
        FROM orgs o WHERE o.id = ${b.bind(p.orgId)}`;
    }
  }
}

/** The reason when the actor CTE returned no row. */
export function missingReason(p: Principal): 'org' | 'actor' {
  return (p.kind === 'platform' || p.kind === 'system') && p.orgId !== undefined ? 'org' : 'actor';
}
