import type { SqlValue } from '../../platform/db.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import type { ScanActor } from './actor.ts';
import type { AssetPassSnapshot } from './asset-types.ts';
import { eventPassPredicate } from './repo-action-authority.ts';
import { actorAuthorityPredicate } from './repo-actor-authority.ts';
import type { AssetGrantGuardInput } from './repo-asset-lineage.ts';
import { nonempty, sessionPredicate } from './repo-asset-session-authority.ts';
import { noCredentialTombstonesSql } from './repo-credential-tombstones.ts';
import { boundOutputPredicate } from './repo-output-predicates.ts';
import { evaluatedPolicyPredicate, passPredicate } from './repo-pass-predicates.ts';

type Predicate = { sql: string; params: SqlValue[] };

type MaterializedAssetGrantGuardInput = AssetGrantGuardInput & { snapshot: AssetPassSnapshot };
export type AssetAuthorityGroups = { pass: Predicate; recipient: Predicate; source: Predicate };

const nullableText = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
export const denied = (): Predicate => ({ sql: '0', params: [] });
const deniedGroups = (): AssetAuthorityGroups => ({
  pass: denied(),
  recipient: denied(),
  source: denied(),
});

export function actorMatchesPass(actor: ScanActor, snapshot: AssetPassSnapshot): boolean {
  const pass = snapshot.pass;
  if (
    !actor?.actor ||
    !actor.settings ||
    typeof actor.settings !== 'object' ||
    !Array.isArray(actor.templateIds) ||
    actor.scanner === undefined ||
    actor.event === undefined ||
    actor.staff === undefined ||
    !nonempty(actor.actor.id) ||
    !nonempty(actor.actorKey) ||
    actor.orgId !== pass.orgId ||
    actor.mode !== pass.mode ||
    (actor.scanner !== null &&
      (typeof actor.scanner !== 'object' || actor.scanner.csrfSecret != null)) ||
    (actor.event !== null && typeof actor.event !== 'object')
  )
    return false;
  if (actor.principal === 'admin') return actor.actor.type === 'user';
  return (
    actor.principal === 'scanner' &&
    actor.actor.type === 'scanner' &&
    actor.scanner !== null &&
    actor.scanner.id === actor.actor.id
  );
}

/** Compose separately bounded original pass, recipient and source authority. */
export function assetGrantPredicate(
  input: MaterializedAssetGrantGuardInput,
  now: number,
): AssetAuthorityGroups {
  const { snapshot, actor, source } = input;
  const { pass, assetPhoto } = snapshot;
  if (
    !Number.isSafeInteger(now) ||
    typeof input.requirePhoto !== 'boolean' ||
    (input.purpose !== 'read' && input.purpose !== 'commit') ||
    (input.requirePhoto && input.purpose !== 'commit') ||
    input.passId !== pass.id ||
    !actorMatchesPass(actor, snapshot) ||
    !nonempty(input.activeVersion) ||
    input.connectionGeneration !== snapshot.connectionGeneration ||
    input.activeVersion !== snapshot.activeTemplateVersion ||
    (snapshot.displayTemplateVersion !== input.activeVersion &&
      (input.purpose !== 'read' || snapshot.displayTemplateVersion !== null)) ||
    pass.status !== 'active' ||
    pass.deletedAt !== null ||
    pass.removedAt !== null ||
    pass.testDataQuarantined !== false ||
    snapshot.transferPending !== false ||
    !Number.isSafeInteger(pass.imageGeneration) ||
    pass.imageGeneration < 0 ||
    typeof snapshot.credentialKeysetCommitment !== 'string' ||
    !/^[a-f0-9]{64}$/.test(snapshot.credentialKeysetCommitment) ||
    typeof snapshot.passPersonalizationSnapshot !== 'string' ||
    typeof snapshot.fieldSourcesSnapshot !== 'string' ||
    !pass.personalization ||
    typeof pass.personalization !== 'object' ||
    Array.isArray(pass.personalization) ||
    !pass.fieldSources ||
    typeof pass.fieldSources !== 'object' ||
    Array.isArray(pass.fieldSources) ||
    !nonempty(pass.authToken) ||
    !nonempty(pass.downloadToken) ||
    !nullableText(pass.releaseId) ||
    !nullableText(pass.holderEmail) ||
    !nullableText(pass.ownerUserId) ||
    !nullableText(pass.scanCode) ||
    !nullableText(pass.barcodeHash) ||
    !nullableText(pass.objectSha256) ||
    !nullableText(pass.externalRef) ||
    (pass.connectionId === null
      ? input.connectionGeneration !== null
      : !nonempty(pass.connectionId) ||
        typeof input.connectionGeneration !== 'number' ||
        !Number.isSafeInteger(input.connectionGeneration) ||
        input.connectionGeneration < 1) ||
    !Object.hasOwn(snapshot, 'assetPhoto') ||
    (input.requirePhoto && assetPhoto === null) ||
    (!source && input.sourceSession !== null) ||
    (source &&
      (!nonempty(source.sourceId) ||
        !nonempty(source.eventId) ||
        !source.actor ||
        !actorMatchesPass(source.actor, snapshot) ||
        source.actor.scanner?.id !== source.sourceId))
  )
    return deniedGroups();

  try {
    if (
      canonicalJson(JSON.parse(snapshot.passPersonalizationSnapshot)) !==
        canonicalJson(pass.personalization) ||
      canonicalJson(JSON.parse(snapshot.fieldSourcesSnapshot)) !== canonicalJson(pass.fieldSources)
    )
      return deniedGroups();
  } catch {
    return deniedGroups();
  }

  if (
    assetPhoto !== null &&
    (!assetPhoto ||
      !nonempty(assetPhoto.version) ||
      !nonempty(assetPhoto.key) ||
      typeof assetPhoto.sha1 !== 'string' ||
      !/^[a-f0-9]{40}$/.test(assetPhoto.sha1) ||
      (assetPhoto.includeInPass !== 0 && assetPhoto.includeInPass !== 1))
  )
    return deniedGroups();

  const refs = input.credentialTombstoneRefs;
  const tombstones = noCredentialTombstonesSql(
    refs,
    { orgIdSql: 'p.org_id', modeSql: 'p.mode' },
    snapshot.credentialKeysetCommitment,
  );
  if (tombstones.sql === '0' || new Set(refs).size !== refs.length) return deniedGroups();

  const stored = input.storedGrant;
  if (stored !== undefined) {
    if (
      !stored ||
      typeof stored.tokenHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(stored.tokenHash) ||
      !Number.isSafeInteger(stored.expiresAt) ||
      stored.expiresAt <= now ||
      typeof stored.credentialRefsJson !== 'string'
    )
      return deniedGroups();
    try {
      const storedRefs: unknown = JSON.parse(stored.credentialRefsJson);
      if (
        !Array.isArray(storedRefs) ||
        storedRefs.length !== refs.length ||
        !storedRefs.every((ref, index) => ref === refs[index])
      )
        return deniedGroups();
    } catch {
      return deniedGroups();
    }
  }

  const clauses: string[] = [];
  const params: SqlValue[] = [];
  const add = (predicate: Predicate) => {
    clauses.push(`(${predicate.sql})`);
    params.push(...predicate.params);
  };
  const passSnapshot = passPredicate(pass, input.connectionGeneration);
  add({
    sql: `CASE WHEN json_valid(p.personalization) AND json_valid(p.field_sources) THEN
      json_type(p.personalization)='object' AND json_type(p.field_sources)='object'
      AND (${passSnapshot.sql}) ELSE 0 END`,
    params: passSnapshot.params,
  });
  add(
    evaluatedPolicyPredicate(
      input.activeVersion,
      snapshot.orgRevision,
      snapshot.templateRevision,
      { ...snapshot, credentialTombstoneRefs: refs },
      input.purpose,
      now,
      'active',
    ),
  );
  add({
    sql: `p.personalization IS ?/* scan-ephemeral-asset-personalization */
      AND p.field_sources IS ?/* scan-ephemeral-asset-field-sources */ AND p.object_sha256 IS ?
      AND p.external_ref IS ?/* scan-ephemeral-asset-external-ref */
      AND p.auth_token IS ?/* scan-ephemeral-asset-auth-token */ AND p.image_generation IS ?`,
    params: [
      snapshot.passPersonalizationSnapshot,
      snapshot.fieldSourcesSnapshot,
      pass.objectSha256,
      pass.externalRef,
      pass.authToken,
      pass.imageGeneration,
    ],
  });
  add(
    assetPhoto === null
      ? {
          sql: 'NOT EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id)',
          params: [],
        }
      : {
          sql: `EXISTS (SELECT 1 FROM member_photos m WHERE m.pass_id=p.id AND m.org_id=p.org_id
        AND m.version IS ? AND m.r2_key IS ?/* scan-ephemeral-asset-photo-key */
        AND m.sha1 IS ? AND m.include_in_pass IS ?)`,
          params: [assetPhoto.version, assetPhoto.key, assetPhoto.sha1, assetPhoto.includeInPass],
        },
  );
  add(tombstones);
  if (stored) {
    add({
      sql: `EXISTS (SELECT 1 FROM scan_asset_grant_provenance grant_row
        WHERE grant_row.token_hash IS ?/* scan-ephemeral-asset-token-hash */
          AND grant_row.org_id=p.org_id AND grant_row.mode=p.mode
          AND grant_row.expires_at IS ? AND grant_row.expires_at>?
          AND grant_row.credential_refs IS ?/* scan-ephemeral-asset-credential-refs */)`,
      params: [stored.tokenHash, stored.expiresAt, now, stored.credentialRefsJson],
    });
  }
  const passClauseCount = clauses.length;
  const passParamCount = params.length;
  add(
    actorAuthorityPredicate({
      actor,
      now,
      event: actor.event,
      templateId: pass.templateId,
      adminEventTemplates: 'adminEventTemplates' in actor && actor.adminEventTemplates === true,
      allowStafflessScreen: !!source && actor.scanner?.deviceRole === 'monitor',
    }),
  );
  add(eventPassPredicate(actor, actor.event));
  add(sessionPredicate(actor, input.recipientSession, now));
  const recipientClauseCount = clauses.length;
  const recipientParamCount = params.length;
  if (source) {
    add(
      actorAuthorityPredicate({
        actor: source.actor,
        now,
        event: source.actor.event,
        templateId: pass.templateId,
        adminEventTemplates:
          'adminEventTemplates' in source.actor && source.actor.adminEventTemplates === true,
        allowStafflessScreen: false,
      }),
    );
    add(eventPassPredicate(source.actor, source.actor.event));
    add(sessionPredicate(source.actor, input.sourceSession, now));
  }
  const pack = (sql: string[], values: SqlValue[]): Predicate => {
    if (!sql.length) return { sql: '1', params: [] };
    const bounded = boundOutputPredicate({ sql: sql.join(' AND '), params: values });
    return { sql: bounded.sql, params: [...bounded.params] };
  };
  return {
    pass: pack(clauses.slice(0, passClauseCount), params.slice(0, passParamCount)),
    recipient: pack(
      clauses.slice(passClauseCount, recipientClauseCount),
      params.slice(passParamCount, recipientParamCount),
    ),
    source: pack(clauses.slice(recipientClauseCount), params.slice(recipientParamCount)),
  };
}
