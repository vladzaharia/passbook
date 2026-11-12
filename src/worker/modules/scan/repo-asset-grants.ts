import type { Mode } from '../../../shared/contracts/common.ts';
import { run, type SqlValue, stmt } from '../../platform/db.ts';
import { safeEqual } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { captureActor } from './asset-authority.ts';
import { assetSnapshotInput, assetSnapshotProofFromInput } from './asset-secrets.ts';
import { assetGrantAuthority } from './asset-sidecar.ts';
import type {
  AssetGuardPlan,
  AssetPassSnapshot,
  AssetSessionSnapshot,
  PreparedAssetGrant,
} from './asset-types.ts';
import type { VerifiedAssetGrant } from './assets.ts';
import { snapshotCredentialEnv } from './credential-input.ts';
import { assetGrantStatementBinder } from './repo-asset-grant-statements.ts';
import { type AssetGrantCsrfResults, prepareAssetGrantGuardParts } from './repo-asset-lineage.ts';
import { validCredentialTombstoneRefs } from './repo-credential-tombstones.ts';
import {
  scanCandidateTemplateReadPredicate,
  scanTemplateSnapshotPredicate,
} from './repo-live-template-snapshot.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';

type Predicate = { sql: string; params: readonly SqlValue[] };
export interface PreparedAssetGrantInsertion {
  (
    now: number,
    extra: Predicate | readonly Predicate[] | undefined,
    requiredWhen?: Predicate,
  ): D1PreparedStatement[];
  checks(now: number): readonly Predicate[];
}

/** Identify only this module's deliberate D1 transaction-abort sentinel. */
export function isAssetGrantAuthorityFailure(error: unknown): boolean {
  for (let current: unknown = error; current instanceof Error; current = current.cause) {
    if (current.message.includes('scan_asset_authority_failed')) return true;
  }
  return false;
}

/** Copy only nonsecret grant data; actor session identifiers stay outside structuredClone. */
function captureGrantPlan(plan: PreparedAssetGrant):
  | (Omit<PreparedAssetGrant, 'guard'> & {
      guard: AssetGuardPlan;
    })
  | null {
  const guard = plan?.guard;
  const sidecar = plan && assetGrantAuthority(plan);
  if (
    !guard ||
    !sidecar?.actor ||
    !Array.isArray(guard.credentialTombstoneRefs) ||
    (sidecar.source !== undefined && !sidecar.source?.actor)
  )
    return null;
  const session = (value: AssetSessionSnapshot | null): AssetSessionSnapshot | null =>
    value && {
      user_id: value.user_id,
      amr: value.amr,
      roles: value.roles,
      created_at: value.created_at,
      expires_at: value.expires_at,
      membership_id: value.membership_id,
      membership_roles: value.membership_roles,
    };
  return {
    tokenHash: plan.tokenHash,
    orgId: plan.orgId,
    mode: plan.mode,
    expiresAt: plan.expiresAt,
    credentialRefsJson: plan.credentialRefsJson,
    guard: {
      passId: guard.passId,
      snapshotProof: guard.snapshotProof,
      actor: captureActor(sidecar.actor),
      source: sidecar.source
        ? {
            sourceId: sidecar.source.sourceId,
            eventId: sidecar.source.eventId,
            actor: captureActor(sidecar.source.actor),
          }
        : undefined,
      recipientSession: session(sidecar.recipientSession),
      sourceSession: session(sidecar.sourceSession),
      connectionGeneration: guard.connectionGeneration,
      activeVersion: guard.activeVersion,
      credentialTombstoneRefs: [...guard.credentialTombstoneRefs],
      requirePhoto: guard.requirePhoto,
      purpose: guard.purpose,
    },
  };
}

/** Prepare asynchronous proofs before binding all statements at one fresh request clock. */
export async function prepareAssetGrantInsertion(
  ctx: ServiceContext,
  plan: PreparedAssetGrant,
  results: AssetGrantCsrfResults | undefined,
  originalSnapshot: AssetPassSnapshot,
  options: { soft?: boolean } = {},
): Promise<PreparedAssetGrantInsertion> {
  const pinned = { ...ctx, env: snapshotCredentialEnv(ctx.env) };
  const db = pinned.env.DB;
  const capturedPlan = captureGrantPlan(plan);
  const passId = originalSnapshot?.pass?.id ?? '';
  const imageGeneration = originalSnapshot?.pass?.imageGeneration;
  const valid =
    !!capturedPlan &&
    !!capturedPlan.guard &&
    !!capturedPlan.guard.actor &&
    !!originalSnapshot?.pass &&
    capturedPlan.orgId === capturedPlan.guard.actor.orgId &&
    capturedPlan.mode === capturedPlan.guard.actor.mode &&
    typeof capturedPlan.tokenHash === 'string' &&
    /^[a-f0-9]{64}$/.test(capturedPlan.tokenHash) &&
    Number.isSafeInteger(capturedPlan.expiresAt) &&
    typeof imageGeneration === 'number' &&
    Number.isSafeInteger(imageGeneration) &&
    imageGeneration >= 0 &&
    validCredentialTombstoneRefs(capturedPlan.guard.credentialTombstoneRefs) &&
    new Set(capturedPlan.guard.credentialTombstoneRefs).size ===
      capturedPlan.guard.credentialTombstoneRefs.length &&
    Array.isArray(originalSnapshot.credentialTombstoneRefs) &&
    originalSnapshot.credentialTombstoneRefs.length ===
      capturedPlan.guard.credentialTombstoneRefs.length &&
    originalSnapshot.credentialTombstoneRefs.every(
      (ref, index) => ref === capturedPlan?.guard.credentialTombstoneRefs[index],
    ) &&
    capturedPlan.credentialRefsJson === JSON.stringify(capturedPlan.guard.credentialTombstoneRefs);
  const makeGuard = valid
    ? await prepareAssetGrantGuardParts(pinned, capturedPlan.guard, results, originalSnapshot)
    : null;
  const templateFence = () =>
    capturedPlan && originalSnapshot?.pass
      ? capturedPlan.guard.purpose === 'read'
        ? scanCandidateTemplateReadPredicate(originalSnapshot)
        : scanTemplateSnapshotPredicate(
            originalSnapshot,
            originalSnapshot.templateSnapshot,
            'commit',
          )
      : null;
  const bind = assetGrantStatementBinder({
    db,
    capturedPlan,
    valid,
    passId,
    imageGeneration,
    makeGuard,
    templateFence,
    soft: options.soft ?? false,
  });
  return Object.assign(bind, {
    checks(now: number): readonly Predicate[] {
      if (
        !valid ||
        !capturedPlan ||
        !makeGuard ||
        !Number.isSafeInteger(now) ||
        capturedPlan.expiresAt <= now
      )
        return [{ sql: '0', params: [] }];
      const checks = makeGuard(now).checks;
      const template = templateFence();
      if (!template) return [{ sql: '0', params: [] }];
      const bounded = boundOutputPredicate(template);
      if (
        bounded.sql === '0' ||
        bounded.params.length + 1 >= 100 ||
        checks.some((check) => check.params.length >= 100)
      )
        return [{ sql: '0', params: [] }];
      return [
        ...checks,
        {
          sql: `EXISTS (SELECT 1 FROM passes scope
          WHERE scope.id=?/* scan-ephemeral-pass-id */ AND (${bounded.sql}))`,
          params: [passId, ...bounded.params],
        },
      ];
    },
  });
}

export function getAssetGrantStmt(
  db: D1Database,
  tokenHash: string,
  orgId: string,
  mode: Mode,
  now: number,
): D1PreparedStatement {
  return stmt(
    db,
    `SELECT expires_at, credential_refs FROM scan_asset_grant_provenance
     WHERE token_hash = ? AND org_id = ? AND mode = ? AND expires_at > ?`,
    [tokenHash, orgId, mode, now],
  );
}

export function assetGrantFromResult(result: D1Result | undefined): {
  expiresAt: number;
  credentialRefs: string;
} | null {
  const row =
    result?.success === true
      ? (result.results?.[0] as { expires_at: number; credential_refs: string } | undefined)
      : undefined;
  return row ? { expiresAt: row.expires_at, credentialRefs: row.credential_refs } : null;
}

export async function getAssetGrant(
  db: D1Database,
  tokenHash: string,
  orgId: string,
  mode: Mode,
  now: number,
): Promise<{ expiresAt: number; credentialRefs: string } | null> {
  return assetGrantFromResult(await getAssetGrantStmt(db, tokenHash, orgId, mode, now).all());
}

/**
 * Prepare the row/photo part of a larger live fence, without retaining the
 * original pass in the verified grant. The closure is request-local only.
 */
export async function prepareStoredAssetGrantFence(
  ctx: ServiceContext,
  input: VerifiedAssetGrant,
  snapshot: AssetPassSnapshot,
): Promise<((now: number) => { sql: string; params: SqlValue[] }) | null> {
  const pinnedEnv = snapshotCredentialEnv(ctx.env);
  if (
    !input?.actor ||
    !input.storedGrant ||
    !Array.isArray(input.credentialTombstoneRefs) ||
    !snapshot?.pass ||
    snapshot.pass.id !== input.passId
  )
    return null;
  const stored = { ...input.storedGrant };
  const refs = [...input.credentialTombstoneRefs];
  const orgId = input.actor.orgId;
  const mode = input.actor.mode;
  const snapshotProof = input.snapshotProof;
  let capturedInput: string;
  try {
    capturedInput = assetSnapshotInput(snapshot);
    if (
      !(await safeEqual(await assetSnapshotProofFromInput(pinnedEnv, capturedInput), snapshotProof))
    )
      return null;
  } catch {
    return null;
  }
  return (now) => {
    try {
      if (assetSnapshotInput(snapshot) !== capturedInput) return { sql: '0', params: [] };
    } catch {
      return { sql: '0', params: [] };
    }
    const pass = snapshot.pass;
    if (
      !Number.isSafeInteger(now) ||
      !Number.isSafeInteger(stored.expiresAt) ||
      stored.expiresAt <= now ||
      !/^[a-f0-9]{64}$/.test(stored.tokenHash) ||
      !validCredentialTombstoneRefs(refs) ||
      stored.credentialRefsJson !== JSON.stringify(refs) ||
      orgId !== pass.orgId ||
      mode !== pass.mode ||
      !Number.isSafeInteger(pass.imageGeneration) ||
      pass.imageGeneration < 0
    )
      return { sql: '0', params: [] };
    const photo = snapshot.assetPhoto;
    const photoSql = photo
      ? `EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id
          AND m.version IS ? AND m.r2_key IS ?/* scan-ephemeral-asset-photo-key */
          AND m.sha1 IS ? AND m.include_in_pass IS ?)`
      : `NOT EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id)`;
    return {
      sql: `p.id=?/* scan-ephemeral-pass-id */ AND p.org_id=? AND p.mode=?
        AND p.image_generation IS ? AND (${photoSql})
        AND EXISTS (SELECT 1 FROM scan_asset_grant_provenance g
          WHERE g.token_hash IS ?/* scan-ephemeral-asset-token-hash */ AND g.org_id=p.org_id AND g.mode=p.mode
            AND g.expires_at IS ? AND g.expires_at>?
            AND g.credential_refs IS ?/* scan-ephemeral-asset-credential-refs */)`,
      params: [
        pass.id,
        pass.orgId,
        pass.mode,
        pass.imageGeneration,
        ...(photo ? [photo.version, photo.key, photo.sha1, photo.includeInPass] : []),
        stored.tokenHash,
        stored.expiresAt,
        now,
        stored.credentialRefsJson,
      ],
    };
  };
}

/** Keep opportunistic cleanup bounded and use the expiry index to select the batch. */
export async function pruneExpiredScanAssetGrants(db: D1Database, now: number): Promise<number> {
  const result = await run(
    db,
    `DELETE FROM scan_asset_grant_provenance WHERE token_hash IN (
       SELECT token_hash FROM scan_asset_grant_provenance
       WHERE expires_at <= ? ORDER BY expires_at LIMIT 100
     )`,
    [now],
  );
  return result.changes;
}
