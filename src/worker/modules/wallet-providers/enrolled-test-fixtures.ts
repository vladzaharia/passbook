// A real enrolment for a fixture org, as an admin sets it up: an org credential with a passing check and a verify,
// the enrolment's source, then On. The account has no legacy envelope and its `revision` column stays 0; every
// pin is `enrolment_revision` and the authority epoch (0229).
import type { SessionAuth } from '../../platform/auth.ts';
import { batch, first, stmt } from '../../platform/db.ts';
import type { Kit } from '../passes/pass-test-fixtures.ts';
import { saveOrgCredential } from './credential-service.ts';
import { setEnrolmentSource } from './enrolment-service.ts';
import { legacyOn } from './legacy-on-test-fixtures.ts';

type Save = Parameters<typeof saveOrgCredential>[3];

/** The org's enrolment for `save.provider` in the session's mode: its own credential, checked, verified, On. */
export async function enrolOn(kit: Kit, auth: SessionAuth, save: Save): Promise<void> {
  const db = kit.env.DB;
  const orgId = kit.org.id;
  const saved = await saveOrgCredential(kit.ctx, auth, orgId, save);
  const version = await first<{ v: string }>(
    db,
    'SELECT current_version_id AS v FROM wallet_credentials WHERE id = ?',
    [saved.id],
  );
  if (!version) throw new Error('The org credential has no version.');
  const now = Date.now();
  const grantId = kit.ctx.ids.id();
  // Only the check job writes a check, under its own grant.
  await batch(db, [
    stmt(
      db,
      `INSERT INTO authority_grants (id, scope, org_id, mode, principal, purpose, target_id, denied, created_at, leak_guard)
       VALUES (?, 'platform', NULL, NULL, 'system:wallet-credential-check', 'platform.job.wallet.credential_check', NULL, NULL, 1, ?)`,
      [grantId, grantId],
    ),
    stmt(
      db,
      'INSERT INTO wallet_credential_checks (id, credential_id, version_id, ok) VALUES (?, ?, ?, 1)',
      [kit.ctx.ids.id(), saved.id, version.v],
    ),
    stmt(db, 'DELETE FROM authority_grants WHERE id = ?', [grantId]),
  ]);
  const revision = saved.revision + 1;
  await batch(db, [
    stmt(
      db,
      `INSERT INTO wallet_credential_events (id, credential_id, revision, kind, version_id, actor_type, actor_id, created_at)
       VALUES (?, ?, ?, 'verify', NULL, 'system', NULL, ?)`,
      [kit.ctx.ids.id(), saved.id, revision, now],
    ),
    stmt(db, 'UPDATE wallet_credentials SET revision = ?, verified_at = ? WHERE id = ?', [
      revision,
      now,
      saved.id,
    ]),
  ]);
  const view = await setEnrolmentSource(kit.ctx, auth, orgId, save.provider, {
    source: 'org',
    expectedRevision: 0,
  });
  // Live's enable also needs a Test round trip from the provider, which no fixture makes: the enable rules are
  // lifted for the one update, as for a legacy account (legacyOn).
  await legacyOn(db, view.accountId);
}
