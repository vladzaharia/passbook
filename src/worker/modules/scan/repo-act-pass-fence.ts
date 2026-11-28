import type { CheckInPolicy } from '../../../shared/contracts/check-in.ts';
import { CheckInPolicySchema } from '../../../shared/contracts/check-in.ts';
import { exactStmt } from '../../platform/db.ts';
import { safeEqual } from '../../platform/ids.ts';
import {
  captureCredentialKeyEnv,
  credentialRefKeysetCommitment,
} from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo-map.ts';
import { effectiveReleaseIs, usedRelease } from './effective-release.ts';
import { RACE_PASS_FENCE } from './race-tags.ts';
import {
  validCredentialKeysetCommitment,
  validCredentialTombstoneRefs,
} from './repo-credential-tombstones.ts';
import {
  completeRelease,
  legacyRelease,
  passJsonOf,
  type ReleaseSnapshot,
  type WalletStatus,
  walletStatusOf,
} from './repo-pass-fence-release.ts';
import { passVisibleSql } from './repo-pass-visible.ts';
import { passJsonFingerprint, personalizationFingerprint } from './scan-personalization-proof.ts';

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
  statement: D1PreparedStatement;
  /** The row must be the result of this statement in the caller's authority batch. */
  complete(row: { rules: string | null } | null | undefined): Promise<ActionPassFence | null>;
}

/**
 * Prepare the pass read of an action: one statement for the batch that evaluates it, and the fence
 * built from its row. The read decides the answer (the pass is still at the generations and the
 * release the evaluation used, and its check-in rules are the ones admission decided on); the actor,
 * staff, event and credential checks are the commit grant's. With `active` the pass must also be
 * shown as live (not voided, removed or expired).
 */
export function prepareSnapshotFence(
  db: D1Database,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
  snapshotRaw: string | null | undefined,
  requiredStatus?: WalletStatus,
  /** A tap-out of a voided or ended pass (OC4): the read keeps every other part of the live standing. */
  exit?: boolean,
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
  const used = usedRelease(snapshotRaw);
  if (
    used === false ||
    (!completeRelease(release) && !legacyRelease(release)) ||
    // The policy version is the release's own (a head or the issued one), or the pass's pinned version without a release.
    (completeRelease(release)
      ? activeTemplateVersion !== release.activeReleaseVersion
      : activeTemplateVersion !== pass.templateVersion) ||
    release.transferPending !== false ||
    (pass.connectionId !== null && typeof connectionGeneration !== 'number') ||
    (pass.connectionId === null && connectionGeneration != null) ||
    !Number.isSafeInteger(credentialGeneration) ||
    credentialGeneration <= 0 ||
    !Number.isSafeInteger(lifecycleGeneration) ||
    lifecycleGeneration < 0 ||
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
  // A live pass is disclosed under F8; a refused or heads-up answer may name a voided or removed
  // one, which stays the same pass: not deleted or quarantined, at its generations, no transfer.
  const standing =
    requiredStatus === 'active' || exit
      ? passVisibleSql('p', {
          credential: '?',
          lifecycle: '?',
          ...(exit ? { anyStatus: true } : {}),
        })
      : `(p.deleted_at IS NULL AND p.test_data_quarantined = 0
        AND p.credential_generation = ? AND p.lifecycle_generation = ?
        AND NOT EXISTS (SELECT 1 FROM pass_credential_transfers pv_t
          WHERE pv_t.pass_id = p.id AND pv_t.state = 'pending'))`;
  // An action's claim is a write: an organization suspended and restored since the read moved its
  // access revision, and the client retries.
  const statement = exactStmt(
    db,
    `${RACE_PASS_FENCE} SELECT (SELECT rules FROM pass_check_in c WHERE c.org_id=p.org_id AND c.pass_id=p.id) AS rules
     FROM passes p WHERE p.id=? AND p.org_id=? AND p.mode=? AND ${standing}
       AND ${effectiveReleaseIs('p')}${
         used === null ? ' AND p.release_id IS NULL AND p.template_version=?' : ''
       }
       AND EXISTS (SELECT 1 FROM orgs o WHERE o.id=p.org_id AND o.status='active' AND o.access_revision=?)`,
    [
      pass.id,
      pass.orgId,
      pass.mode,
      credentialGeneration,
      lifecycleGeneration,
      used === null ? null : used[0],
      ...(used === null ? [pass.templateVersion] : []),
      orgRevision,
    ],
  );
  const keys = captureCredentialKeyEnv(env);
  const keysetCurrent = credentialRefKeysetCommitment(keys).then((actual) =>
    safeEqual(actual, credentialKeysetCommitment),
  );
  return {
    keysetCurrent,
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

/** The pass read of an answer that is a refusal or heads-up: any state of the pass, as evaluated. */
export async function passSnapshotFence(
  db: D1Database,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
  snapshotRaw: string | null | undefined,
): Promise<ActionPassFence | null> {
  const prepared = prepareSnapshotFence(
    db,
    pass,
    checkInRules,
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    env,
    release,
    snapshotRaw,
  );
  if (!prepared || !(await prepared.keysetCurrent)) return null;
  return prepared.complete(await prepared.statement.first<{ rules: string | null }>());
}

/** The pass read of an action on an active, present pass: it rides the batch that evaluates the action. */
export function prepareActionPassFence(
  db: D1Database,
  pass: Pass,
  checkInRules: CheckInPolicy | undefined,
  connectionGeneration: number | null | undefined,
  activeTemplateVersion: string | null | undefined,
  orgRevision: number | null | undefined,
  templateRevision: number | null | undefined,
  now: number,
  env: object,
  release: ReleaseSnapshot | null | undefined,
  snapshotRaw: string | null | undefined,
  /**
   * OC4: a tap-out of a voided or ended pass may read it. Evaluation sets it for any inactive Found on a
   * scanner that can tap out, before it decides; only an exit is kept (`evaluate` refuses the rest, and
   * commit throws unless the state is `out`). The pass is still fenced to its evaluated status at commit
   * (`scanPassChecks`). Every other action keeps the live-only fence below.
   */
  exit?: boolean,
): PreparedActionPassFence | null {
  if (pass.removedAt !== null || (pass.status !== 'active' && !exit)) return null;
  return prepareSnapshotFence(
    db,
    pass,
    checkInRules ?? {},
    connectionGeneration,
    activeTemplateVersion,
    orgRevision,
    templateRevision,
    now,
    env,
    release,
    snapshotRaw,
    exit ? undefined : 'active',
    exit,
  );
}
