import { type CheckInPolicy, CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { type SqlValue, stmt } from '../../platform/db.ts';
import { safeEqual } from '../../platform/ids.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo-map.ts';
import {
  validCredentialKeysetCommitment,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';
import {
  completeRelease,
  evaluatedPolicyPredicate,
  legacyRelease,
  passJsonOf,
  passPredicate,
  type ReleaseSnapshot,
  type WalletStatus,
  walletStatusOf,
} from './repo-pass-predicates.ts';
import { passJsonFingerprint, personalizationFingerprint } from './scan-personalization-proof.ts';

type Db = D1Database;

/** The pass state read after evaluation and fenced again in the gate transaction. */
export interface ActionPassFence {
  activeReleaseId: string | null;
  activeReleaseGeneration: number | null;
  activeReleaseVersion: string | null;
  activeReleaseCandidateHash: string | null;
  identityPassTypeIdentifier: string;
  identityTeamIdentifier: string;
  identityRevision: number;
  credentialGeneration: number;
  lifecycleGeneration: number;
  noPendingTransfer: true;
  transferPending: false;
  credentialTombstoneRefs: readonly string[];
  credentialKeysetCommitment: string;
  passJsonSnapshot: string | null;
  passJsonHash: string | null;
  walletVersion: number;
  walletTemplateVersion: string | null;
  versionPersonalization: string | null;
  personalizationHash: string | null;
  evaluatedPersonalizationHash: string;
  walletStatus: WalletStatus;
  rules: string | null;
  connectionGeneration: number | null;
  activeTemplateVersion: string;
  orgRevision: number;
  templateRevision: number;
}

/** A pass fence read that can share a transaction with the claim and effect snapshot. */
export interface PreparedActionPassFence {
  /** Await before using guard so a changed process key cannot create a stale marker. */
  keysetCurrent: Promise<boolean>;
  /** Exact original pass, release, credential and rules predicate for trusted alias p. */
  guard: { sql: string; params: readonly SqlValue[] };
  statement: D1PreparedStatement;
  /** The row must be the result of this statement in the caller's authority batch. */
  complete(row: { rules: string | null } | null | undefined): Promise<ActionPassFence | null>;
}

export function prepareSnapshotFence(
  db: Db,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
  purpose: 'read' | 'commit',
  requiredStatus?: WalletStatus,
): PreparedActionPassFence | null {
  const passJsonSnapshot = passJsonOf(release);
  const identityPassTypeIdentifier = release?.identityPassTypeIdentifier;
  const identityTeamIdentifier = release?.identityTeamIdentifier;
  const identityRevision = release?.identityRevision;
  const walletVersion = release?.walletVersion;
  const walletTemplateVersion = release?.walletTemplateVersion;
  const versionPersonalization = release?.versionPersonalization;
  const refs = release?.credentialTombstoneRefs;
  const credentialKeysetCommitment = release?.credentialKeysetCommitment;
  const credentialGeneration = pass.credentialGeneration;
  const lifecycleGeneration = pass.lifecycleGeneration;
  const passIdentity = { orgId: pass.orgId, id: pass.id };
  const evaluatedPersonalization = JSON.stringify(pass.personalization);
  const evaluatedRules = checkInRules === undefined ? undefined : JSON.stringify(checkInRules);
  const walletStatus = walletStatusOf(passJsonSnapshot, now);
  if (
    (!completeRelease(release) && !legacyRelease(release)) ||
    release.transferPending !== false ||
    !validCredentialTombstoneRefs(refs) ||
    !validCredentialKeysetCommitment(credentialKeysetCommitment) ||
    !activeTemplateVersion ||
    typeof orgRevision !== 'number' ||
    typeof templateRevision !== 'number' ||
    typeof passJsonSnapshot !== 'string' ||
    typeof identityPassTypeIdentifier !== 'string' ||
    typeof identityTeamIdentifier !== 'string' ||
    typeof identityRevision !== 'number' ||
    !Number.isSafeInteger(identityRevision) ||
    identityRevision <= 0 ||
    !walletStatus ||
    (requiredStatus !== undefined && walletStatus !== requiredStatus) ||
    typeof walletVersion !== 'number' ||
    !Number.isSafeInteger(walletVersion) ||
    walletVersion <= 0 ||
    walletVersion > pass.version ||
    (walletTemplateVersion !== null && typeof walletTemplateVersion !== 'string') ||
    (versionPersonalization !== null && typeof versionPersonalization !== 'string')
  )
    return null;
  const frozenRelease = { ...release, credentialTombstoneRefs: Object.freeze([...refs]) };
  const predicate = passPredicate(pass, connectionGeneration);
  const policy = evaluatedPolicyPredicate(
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    frozenRelease,
    purpose,
    now,
    walletStatus,
  );
  if (policy.sql === '0') return null;
  const rulesSql =
    evaluatedRules === undefined
      ? ''
      : `AND EXISTS (SELECT 1 FROM (
    SELECT COALESCE((SELECT c.rules FROM pass_check_in c WHERE c.org_id=p.org_id AND c.pass_id=p.id),'{}') AS rules
  ) original_rules WHERE CASE WHEN json_valid(original_rules.rules) THEN
    json_type(original_rules.rules)='object'
    AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(original_rules.rules)
      EXCEPT SELECT fullkey,type,atom FROM json_tree(?/* scan-ephemeral-check-in-rules */))
    AND NOT EXISTS (SELECT fullkey,type,atom FROM json_tree(?/* scan-ephemeral-check-in-rules */)
      EXCEPT SELECT fullkey,type,atom FROM json_tree(original_rules.rules))
    ELSE 0 END)`;
  const guard = {
    sql: `(${predicate.sql}) AND (${policy.sql}) ${rulesSql}`,
    params: [
      ...predicate.params,
      ...policy.params,
      ...(evaluatedRules === undefined ? [] : [evaluatedRules, evaluatedRules]),
    ],
  };
  const statement = stmt(
    db,
    `SELECT (SELECT rules FROM pass_check_in c WHERE c.org_id=p.org_id AND c.pass_id=p.id) AS rules
     FROM passes p WHERE ${guard.sql}`,
    guard.params,
  );
  const keys = captureCredentialKeyEnv(env);
  const keysetCurrent = credentialRefKeysetCommitment(keys).then((actual) =>
    safeEqual(actual, credentialKeysetCommitment),
  );
  return {
    keysetCurrent,
    guard,
    statement,
    async complete(row) {
      if (!(await keysetCurrent)) return null;
      if (!row) return null;
      const rawRules = row.rules;
      if (evaluatedRules !== undefined) {
        const rules = CheckInPolicySchema.parse(JSON.parse(rawRules ?? '{}'));
        if (JSON.stringify(rules) !== evaluatedRules) return null;
      }
      const [passJsonHash, personalizationHash, evaluatedPersonalizationHash] = await Promise.all([
        passJsonFingerprint(keys, passIdentity, passJsonSnapshot, identityRevision),
        versionPersonalization === null
          ? null
          : personalizationFingerprint(
              keys,
              passIdentity.orgId,
              passIdentity.id,
              walletVersion,
              versionPersonalization,
            ),
        personalizationFingerprint(
          keys,
          passIdentity.orgId,
          passIdentity.id,
          walletVersion,
          evaluatedPersonalization,
        ),
      ]);
      if (
        passJsonHash === null ||
        (versionPersonalization !== null && personalizationHash === null) ||
        evaluatedPersonalizationHash === null
      )
        return null;
      return {
        rules: rawRules,
        connectionGeneration: connectionGeneration ?? null,
        activeTemplateVersion,
        passJsonSnapshot,
        passJsonHash,
        walletVersion,
        walletTemplateVersion,
        versionPersonalization,
        personalizationHash,
        evaluatedPersonalizationHash,
        walletStatus,
        identityPassTypeIdentifier,
        identityTeamIdentifier,
        identityRevision,
        credentialGeneration,
        lifecycleGeneration,
        noPendingTransfer: true,
        transferPending: false,
        credentialTombstoneRefs: frozenRelease.credentialTombstoneRefs,
        credentialKeysetCommitment,
        activeReleaseId: frozenRelease.activeReleaseId,
        activeReleaseGeneration: frozenRelease.activeReleaseGeneration,
        activeReleaseVersion: frozenRelease.activeReleaseVersion,
        activeReleaseCandidateHash: frozenRelease.activeReleaseCandidateHash,
        orgRevision,
        templateRevision,
      };
    },
  };
}
