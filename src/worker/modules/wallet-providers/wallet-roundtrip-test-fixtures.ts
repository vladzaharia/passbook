// A new-model Test enrolment with a release, an instance and a callback binding, seeded by hand: the
// services that write instances still require a legacy account (WA7 lifts that), so the insert guards
// of these tables are dropped in the file's own database and the rows are inserted directly.
import { env } from 'cloudflare:workers';
import { makeUser } from '../../../../test/helpers/index.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { all, first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { createSession, resolveSession } from '../auth/sessions.ts';
import { grantKitMembership } from '../passes/apple-release-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import type { Pass } from '../passes/repo.ts';
import { readGoogleCallbackVerification } from './account-service.ts';
import { savePlatformCredential } from './credential-service.ts';
import { enableEnrolment, setEnrolmentSource } from './enrolment-service.ts';
import { googleObjectIds } from './google-ids.ts';
import type { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { addCheck } from './repo-wallet-credentials-test-fixtures.ts';

export type OfferKit = Awaited<ReturnType<typeof setupWalletOfferKit>>;
type Mode = 'live' | 'test';

const GUARDED = [
  'template_candidates',
  'template_approvals',
  'template_releases',
  'wallet_provider_instances',
  'wallet_provider_instance_operations',
  'wallet_google_callback_bindings',
];

export async function dropInsertGuards(db: D1Database): Promise<void> {
  const rows = await all<{ name: string }>(
    db,
    `SELECT name FROM sqlite_master WHERE type = 'trigger'
     AND tbl_name IN (${GUARDED.map(() => '?').join(', ')})`,
    GUARDED,
  );
  for (const { name } of rows) await run(db, `DROP TRIGGER ${name}`);
}

export async function sessionFor(
  f: OfferKit,
  userId: string,
  roles: ('admin' | 'user')[],
  mode: Mode,
): Promise<SessionAuth> {
  const { kit } = f;
  const session = await createSession(kit.ctx, {
    userId,
    roles,
    amr: 'oidc',
    ipPrefix: null,
    userAgent: null,
  });
  const resolved = await resolveSession(kit.env, kit.clock, session.cookieValue);
  if (!resolved) throw new Error('Session did not resolve.');
  return { ...resolved, mode };
}

export async function orgMember(f: OfferKit, orgId: string, mode: Mode) {
  const user = await makeUser(f.kit.fx);
  await grantKitMembership(f.kit, orgId, user.id, ['org_admin']);
  return sessionFor(f, user.id, ['user'], mode);
}

/** One platform credential for the mode (an issuer id per mode, as identities are unique). */
export async function platformSource(f: OfferKit, mode: Mode, issuerId: string) {
  const admin = await sessionFor(f, (await makeUser(f.kit.fx)).id, ['admin', 'user'], mode);
  const saved = await savePlatformCredential(f.kit.ctx, admin, {
    mode,
    provider: 'google',
    expectedRevision: 0,
    credentials: { ...f.google, issuerId },
  });
  const version = await first<{ v: string }>(
    env.DB,
    'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
    [saved.id],
  );
  return { id: saved.id, versionId: version?.v ?? '' };
}

/** The org's enrolment on the platform source: Off, or On when `enable` (a fresh check row first). */
export async function enrol(
  f: OfferKit,
  orgId: string,
  mode: Mode,
  source: { id: string; versionId: string },
  enable: boolean,
) {
  const auth = await orgMember(f, orgId, mode);
  const view = await setEnrolmentSource(f.kit.ctx, auth, orgId, 'google', {
    source: 'platform',
    expectedRevision: 0,
  });
  if (enable) {
    await addCheck(source.id, source.versionId);
    await enableEnrolment(f.kit.ctx, auth, orgId, 'google', { expectedRevision: 1 });
  }
  const row = await first<{ id: string; rev: number }>(
    env.DB,
    'SELECT id, enrolment_revision AS rev FROM wallet_provider_accounts WHERE id = ?',
    [view.accountId],
  );
  if (!row) throw new Error('Missing enrolment.');
  return { auth, accountId: row.id, revision: row.rev };
}

export async function verificationOf(
  f: OfferKit,
  orgId: string,
  mode: Mode,
  e: { accountId: string; revision: number },
) {
  const v = await readGoogleCallbackVerification(f.kit.ctx, {
    orgId,
    mode,
    accountId: e.accountId,
    accountRevision: e.revision,
    credentialKeysetCommitment: await requireCredentialRefKeyset(env.DB, f.kit.env),
  });
  if (!v) throw new Error('Missing callback verification.');
  return v;
}

const hex = async (s: string) => sha256Hex(s);

/** A release, an active instance with its succeeded upsert, and the callback binding, on the enrolment. */
export async function seedInstance(
  f: OfferKit,
  pass: Pass,
  e: { accountId: string; revision: number },
  verification: { issuerId: string; objectIdHmacKey: Uint8Array },
) {
  const { kit } = f;
  const db = env.DB;
  const ids = kit.ctx.ids;
  const now = kit.clock.now();
  const keyset = await requireCredentialRefKeyset(db, kit.env);
  const hash = await hex(`candidate-${ids.id()}`);
  const [candidateId, approvalId, releaseId, instanceId, operationId] = [
    ids.id(),
    ids.id(),
    ids.id(),
    ids.id(),
    ids.id(),
  ];
  await run(
    db,
    `INSERT INTO template_candidates (id, template_id, org_id, mode, provider, version, candidate_hash,
      content_hash, adapter_revision, adapter_capabilities, audience_policy_revision, author_id,
      created_at, source_release_id, provider_account_id, provider_account_revision, credential_keyset_commitment)
     VALUES (?, ?, ?, ?, 'google', ?, ?, ?, 1, '[]', 1, 'author', ?, ?, ?, ?, ?)`,
    [
      candidateId,
      pass.templateId,
      pass.orgId,
      pass.mode,
      pass.templateVersion,
      hash,
      hash,
      now,
      pass.releaseId,
      e.accountId,
      e.revision,
      keyset,
    ],
  );
  await run(
    db,
    `INSERT INTO template_approvals (id, candidate_id, candidate_hash, reviewer_id, created_at,
      credential_keyset_commitment) VALUES (?, ?, ?, 'reviewer', ?, ?)`,
    [approvalId, candidateId, hash, now, keyset],
  );
  await run(
    db,
    `INSERT INTO template_releases (id, template_id, org_id, mode, provider, generation, version,
      candidate_hash, content_hash, adapter_revision, adapter_capabilities, audience_policy_revision,
      source, action, candidate_id, approval_id, created_by, created_at, credential_keyset_commitment)
     VALUES (?, ?, ?, ?, 'google', 1, ?, ?, ?, 1, '[]', 1, 'approved', 'release', ?, ?, 'author', ?, ?)`,
    [
      releaseId,
      pass.templateId,
      pass.orgId,
      pass.mode,
      pass.templateVersion,
      hash,
      hash,
      candidateId,
      approvalId,
      now,
      keyset,
    ],
  );
  const live = await first<{
    version: number;
    revision: number;
    credential_generation: number;
    lifecycle_generation: number;
  }>(
    db,
    'SELECT version, revision, credential_generation, lifecycle_generation FROM passes WHERE id = ?',
    [pass.id],
  );
  if (!live) throw new Error('Missing pass.');
  await run(
    db,
    `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, account_id,
      identity_projection_release_id, credential_generation, lifecycle, desired_version,
      desired_operation_id, created_at, updated_at, credential_keyset_commitment)
     VALUES (?, ?, ?, ?, 'google', ?, ?, ?, 'active', 1, ?, ?, ?, ?)`,
    [
      instanceId,
      pass.id,
      pass.orgId,
      pass.mode,
      e.accountId,
      releaseId,
      live.credential_generation,
      operationId,
      now,
      now,
      keyset,
    ],
  );
  await run(
    db,
    `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash,
      pass_version, pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id,
      projection_release_id, account_revision, adapter_revision, policy_revision, state, attempts,
      created_at, credential_keyset_commitment)
     VALUES (?, ?, 1, 'upsert', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 'succeeded', 1, ?, ?)`,
    [
      operationId,
      instanceId,
      await hex(operationId),
      live.version,
      live.revision,
      live.credential_generation,
      live.lifecycle_generation,
      pass.releaseId,
      releaseId,
      e.revision,
      now,
      keyset,
    ],
  );
  const { classId, objectId } = await googleObjectIds(
    verification.issuerId,
    verification.objectIdHmacKey,
    {
      tenantId: pass.orgId,
      mode: pass.mode,
      releaseId,
      passId: pass.id,
      credentialGeneration: live.credential_generation,
    },
  );
  await run(
    db,
    `INSERT INTO wallet_google_callback_bindings (instance_id, account_id, class_id_hash,
      object_id_hash, created_at, credential_keyset_commitment) VALUES (?, ?, ?, ?, ?, ?)`,
    [instanceId, e.accountId, await hex(classId), await hex(objectId), now, keyset],
  );
  return { instanceId, classId, objectId };
}
