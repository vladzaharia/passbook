import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import { validityOf } from '../../../shared/pass-view/validity.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { Pass } from '../passes/repo-map.ts';
import type { ScanActor } from './actor.ts';
import { actorCsrfFence } from './actor-csrf.ts';
import { eventPassPredicate } from './repo-action-authority.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import type { Candidate } from './repo-lookup.ts';
import {
  andOutputPredicates,
  type OutputPredicate,
  outputPredicatesCurrent,
} from './repo-output-predicates.ts';
import {
  evaluatedPolicyPredicate,
  passPredicate,
  type ReleaseSnapshot,
} from './repo-pass-predicates.ts';
import { releaseBuildCompatibilityPredicate } from './repo-release-build.ts';
import type { ScanEventRow } from './repo-scope.ts';

/** Original, internal snapshots used to construct one pass-bearing output. */
export interface OutputAuthority {
  actor: ScanActor;
  event: ScanEventRow | null;
  now: number;
  adminEventTemplates?: boolean;
  /** Template scope for this pass; cross-mode warnings use a separate actor-only proof. */
  templateId?: string;
  pass: Pass;
  connectionGeneration: number | null | undefined;
  activeTemplateVersion: string | null | undefined;
  orgRevision: number | null | undefined;
  templateRevision: number | null | undefined;
  /** Original submitted token refs; [] only for explicitly authorized non-credential selection. */
  credentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
  release: ReleaseSnapshot & Partial<Pick<Candidate, 'assetPhoto'>>;
  purpose?: 'read' | 'commit';
  /** Only a read of identity fields without a photo may ignore image-epoch changes. */
  imagePolicy?: 'strict' | 'identity-only';
  /** Compare the original display build selection, including an incompatible head. */
  displayTemplateVersion?: string | null;
  checkInRules?: CheckInPolicy;
  /** When supplied, the lookup index must still be the original one. */
  lookupHash?: string | null;
  /** A Found projection must remain active at the instant it is disclosed. */
  requireActive?: boolean;
  /** Refusal-only commits may retain an inactive Wallet while still requiring a compatible build. */
  allowInactive?: boolean;
  expectedWalletStatus?: 'active' | 'voided' | 'expired';
  /** Additional gate or occupancy proof evaluated in the same read. */
  extra?: { sql: string; params: readonly SqlValue[] };
  requirePhoto?: boolean;
}

/** Pass-only half for callers that bind a different tenant or API-key authority. */
export type OutputPassAuthority = Omit<
  OutputAuthority,
  'actor' | 'event' | 'adminEventTemplates' | 'templateId' | 'extra'
>;

function walletStatus(
  release: ReleaseSnapshot,
  now: number,
): 'active' | 'voided' | 'expired' | null {
  const snapshot =
    release.passJsonSnapshot !== undefined ? release.passJsonSnapshot : release.passJson;
  if (typeof snapshot !== 'string') return null;
  try {
    const value: unknown = JSON.parse(snapshot);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return validityOf(value as { voided?: unknown; expirationDate?: unknown }, now).status;
  } catch {
    return null;
  }
}

/** Exact source, Wallet and policy snapshot, independent of the kind of caller. */
export function passOutputPredicate(input: OutputPassAuthority): OutputPredicate {
  const { pass, now, release } = input;
  const purpose = input.purpose ?? 'read';
  const status = walletStatus(release, now);
  if (
    input.imagePolicy !== undefined &&
    input.imagePolicy !== 'strict' &&
    input.imagePolicy !== 'identity-only'
  )
    return { sql: '0', params: [] };
  if (input.imagePolicy === 'identity-only' && (purpose !== 'read' || input.requirePhoto))
    return { sql: '0', params: [] };
  if (
    !status ||
    release.transferPending !== false ||
    !Array.isArray(input.credentialTombstoneRefs) ||
    typeof input.credentialKeysetCommitment !== 'string' ||
    !/^[0-9a-f]{64}$/.test(input.credentialKeysetCommitment) ||
    release.credentialKeysetCommitment !== input.credentialKeysetCommitment ||
    ((input.requireActive || (purpose === 'commit' && !input.allowInactive)) &&
      status !== 'active') ||
    (input.expectedWalletStatus !== undefined && status !== input.expectedWalletStatus) ||
    typeof release.walletVersion !== 'number' ||
    release.walletVersion > pass.version ||
    (release.versionPersonalization !== null && typeof release.versionPersonalization !== 'string')
  )
    return { sql: '0', params: [] };

  const snapshot = passPredicate(
    pass,
    input.connectionGeneration,
    input.imagePolicy === 'identity-only' ? { imagePolicy: 'identity-only' } : undefined,
  );
  const policy = evaluatedPolicyPredicate(
    input.activeTemplateVersion,
    input.orgRevision,
    input.templateRevision,
    release,
    purpose,
    now,
    status,
  );
  const fieldSources = JSON.stringify(pass.fieldSources);
  const parts = [
    `CASE WHEN json_valid(p.personalization) THEN (${snapshot.sql}) ELSE 0 END`,
    policy.sql,
    // Preserve the original source fields used by display, privacy and admission as well as
    // the remaining persisted pass metadata omitted by the shared gate predicate.
    `p.auth_token IS ?/* scan-ephemeral-auth-token */
      AND p.web_service_url IS ?/* scan-ephemeral-web-service-url */
      AND p.external_id IS ?/* scan-ephemeral-external-id */
      AND p.display_title IS ?/* scan-ephemeral-display-title */
      AND p.display_subtitle IS ?/* scan-ephemeral-display-subtitle */
      AND p.created_at=? AND p.modified_at=? AND p.modified_collision=?
      AND p.object_sha256 IS ? AND p.object_size IS ?
      AND p.external_ref IS ?/* scan-ephemeral-external-ref */
      AND p.sync_error_code IS ?/* scan-ephemeral-sync-error-code */
      AND p.refresh_requested_at IS ? AND p.last_refreshed_at IS ? AND p.content_hash IS ?`,
    `CASE WHEN json_valid(p.field_sources) THEN json_type(p.field_sources)='object'
      AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(p.field_sources)
        EXCEPT SELECT fullkey,type,atom FROM json_tree(?/* scan-ephemeral-field-sources */))
      AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(?/* scan-ephemeral-field-sources */)
        EXCEPT SELECT fullkey,type,atom FROM json_tree(p.field_sources))
      ELSE 0 END`,
  ];
  const params: SqlValue[] = [
    ...snapshot.params,
    ...policy.params,
    pass.authToken,
    pass.webServiceUrl,
    pass.externalId,
    pass.displayTitle,
    pass.displaySubtitle,
    pass.createdAt,
    pass.modifiedAt,
    pass.modifiedCollision ? 1 : 0,
    pass.objectSha256,
    pass.objectSize,
    pass.externalRef,
    pass.syncErrorCode,
    pass.refreshRequestedAt,
    pass.lastRefreshedAt,
    pass.contentHash,
    fieldSources,
    fieldSources,
  ];

  const active = input.activeTemplateVersion;
  if (
    input.displayTemplateVersion !== undefined &&
    (!active || (input.displayTemplateVersion !== null && input.displayTemplateVersion !== active))
  )
    return { sql: '0', params: [] };
  const compatible = releaseBuildCompatibilityPredicate(active ?? '');
  const checkDisplay =
    input.displayTemplateVersion !== undefined && pass.templateVersion !== active;
  const displayIsCompatible = input.displayTemplateVersion === active;
  parts.push(`(?=0 OR ((?=1 AND (${compatible.sql})) OR (?=0 AND NOT (${compatible.sql}))))`);
  params.push(
    checkDisplay ? 1 : 0,
    displayIsCompatible ? 1 : 0,
    ...compatible.params,
    displayIsCompatible ? 1 : 0,
    ...compatible.params,
  );

  // Zod normalizes key order when the candidate is read. Compare JSON trees rather than raw text.
  const rules = JSON.stringify(input.checkInRules ?? {});
  parts.push(`(?=0 OR EXISTS (SELECT 1 FROM (
    SELECT COALESCE((SELECT c.rules FROM pass_check_in c WHERE c.org_id=p.org_id AND c.pass_id=p.id),'{}') AS rules
  ) original_rules WHERE CASE WHEN json_valid(original_rules.rules) THEN
    json_type(original_rules.rules)='object'
    AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(original_rules.rules)
      EXCEPT SELECT fullkey,type,atom FROM json_tree(?/* scan-ephemeral-check-in-rules */))
    AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(?/* scan-ephemeral-check-in-rules */)
      EXCEPT SELECT fullkey,type,atom FROM json_tree(original_rules.rules))
    ELSE 0 END))`);
  params.push(input.checkInRules === undefined ? 0 : 1, rules, rules);
  parts.push('(?=0 OR p.lookup_hash IS ?/* scan-ephemeral-lookup-hash */)');
  params.push(input.lookupHash === undefined ? 0 : 1, input.lookupHash ?? null);
  if (input.requirePhoto) {
    const photo = release.assetPhoto;
    if (
      !photo ||
      typeof photo.version !== 'string' ||
      typeof photo.key !== 'string' ||
      typeof photo.sha1 !== 'string' ||
      (photo.includeInPass !== 0 && photo.includeInPass !== 1)
    )
      return { sql: '0', params: [] };
    // The shared pass predicate already fences the original image generation.
    parts.push(`EXISTS (SELECT 1 FROM member_photos m WHERE m.org_id=p.org_id AND m.pass_id=p.id
      AND m.version=? AND m.r2_key=?/* scan-ephemeral-photo-key */ AND m.sha1=? AND m.include_in_pass=?)`);
    params.push(photo.version, photo.key, photo.sha1, photo.includeInPass);
  }
  const tombstones = noCredentialTombstonesSql(
    input.credentialTombstoneRefs,
    {
      orgIdSql: 'p.org_id',
      modeSql: 'p.mode',
    },
    input.credentialKeysetCommitment,
  );
  parts.push(tombstones.sql);
  params.push(...tombstones.params);

  return {
    sql: `EXISTS (SELECT 1 FROM passes p WHERE ${parts.map((part) => `(${part})`).join(' AND ')})`,
    params,
  };
}

/** Compose the canonical actor and pass policy into the same database snapshot. */
export function outputAuthorityPredicate(input: OutputAuthority): OutputPredicate {
  if (input.pass.orgId !== input.actor.orgId || input.pass.mode !== input.actor.mode)
    return { sql: '0', params: [] };
  const authority = actorAuthorityPredicate({
    actor: input.actor,
    now: input.now,
    event: input.event,
    templateId: input.templateId,
    adminEventTemplates: input.adminEventTemplates ?? input.actor.adminEventTemplates === true,
  });
  const pass = passOutputPredicate(input);
  const event = eventPassPredicate(input.actor, input.event);
  const matchingPass: OutputPredicate = event.params.length
    ? {
        sql: `EXISTS (SELECT 1 FROM passes p WHERE p.id=?/* scan-ephemeral-pass-id */ AND p.org_id=? AND p.mode=? AND (${event.sql}))`,
        params: [input.pass.id, input.pass.orgId, input.pass.mode, ...event.params],
      }
    : { sql: '1', params: [] };
  return andOutputPredicates([
    authority,
    pass,
    matchingPass,
    ...(input.extra ? [input.extra] : []),
  ]);
}

/** Verify the original actor secret before binding its final scalar fence. */
export async function actorOutputFenceStmt(
  ctx: ServiceContext,
  actor: ScanActor,
): Promise<D1PreparedStatement | null> {
  const fence = await actorCsrfFence(ctx, actor);
  if (!fence) return null;
  return stmt(
    ctx.env.DB,
    `SELECT CASE WHEN (${fence.sql}) THEN 1 ELSE 0 END AS actor_authorized`,
    fence.params,
  );
}

/** All results, including large lists, are checked against the same D1 read snapshot. */
export function outputAuthoritiesCurrent(
  db: D1Database,
  inputs: readonly OutputAuthority[],
): Promise<boolean[]> {
  return outputPredicatesCurrent(db, inputs.map(outputAuthorityPredicate));
}

/** Fail a whole response if any original source or actor snapshot is no longer current. */
export async function outputAuthoritiesAllCurrent(
  db: D1Database,
  inputs: readonly OutputAuthority[],
): Promise<boolean> {
  return (await outputAuthoritiesCurrent(db, inputs)).every(Boolean);
}

/** Read-side fence immediately before returning a pass-bearing response. */
export async function outputAuthorityCurrent(
  db: D1Database,
  input: OutputAuthority,
): Promise<boolean> {
  return (await outputAuthoritiesCurrent(db, [input]))[0] === true;
}
