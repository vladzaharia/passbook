// TURN-0 rollback: with Google `draining` in Live, an object already saved still goes inactive on a void and on a
// removal (PUT, then a GET to confirm), while an edit, a message and a new save link never reach Google.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { withoutTrigger } from '../../../../test/helpers/triggers.ts';
import { first, run } from '../../platform/db.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { removePass } from '../passes/remove.ts';
import { updatePass, voidPass } from '../passes/service.ts';
import { fixture, mock, restore, tokenOf } from './google-runtime-test-fixtures.ts';
import { issueWalletOffer, listWalletOffers } from './offers.ts';
import { setWalletReleaseForTest } from './provider-policy.ts';
import { releaseRows } from './release-test-fixtures.ts';
import { drainWalletProviderSync } from './sync.ts';

afterEach(() => {
  for (const undo of restore.splice(0).reverse()) undo();
  vi.unstubAllGlobals();
});

const system = { type: 'system', id: null } as const;

/** A saved Google object (released), then Google Live set to draining. */
async function draining() {
  const { f } = await fixture();
  const token = await tokenOf(f);
  await issueWalletOffer(f.kit.ctx, token, 'google');
  restore.push(setWalletReleaseForTest('draining', { provider: 'google', mode: 'live' }));
  const jobCtx = jobCtxOf(f.kit);
  const scope = { orgId: f.kit.org.id, mode: 'live', principal: 'session' } as const;
  const google = () =>
    mock.requests.filter((r) => r.path.includes('walletobjects')).map((r) => r.method);
  return { f, jobCtx, scope, token, google };
}

const object = () => [...mock.google.genericObject.values()][0];

describe('Google draining in Live', () => {
  it('refuses an edit and every new save link, then still sends a void', async () => {
    const { f, jobCtx, scope, token, google } = await draining();
    const before = google().length;
    await updatePass(
      jobCtx,
      system,
      f.pass.id,
      { input: { memberName: 'Edited' } },
      { scope: null },
    );
    await drainWalletProviderSync(jobCtx);
    expect(google()).toHaveLength(before);
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toThrow();
    await voidPass(jobCtx, system, f.pass.id, scope);
    await drainWalletProviderSync(jobCtx);
    expect(google().slice(before)).toContain('PUT');
    expect(google().slice(before)).not.toContain('PATCH');
    expect(object()).toMatchObject({ state: 'INACTIVE' });
  });

  it('sends a removal', async () => {
    const { f, jobCtx, google } = await draining();
    const before = google().length;
    await removePass(jobCtx, system, f.pass.id, {}, null);
    await drainWalletProviderSync(jobCtx);
    expect(google().slice(before)).toContain('PUT');
    expect(object()).toMatchObject({ state: 'INACTIVE' });
  });

  // The database refuses to go dark while this copy can still be in a wallet (0229).
  it('cannot go back to dark while the copy is open', async () => {
    const { f } = await draining();
    await run(
      f.kit.env.DB,
      "UPDATE wallet_provider_releases SET state = 'draining', changed_at = 1 WHERE provider = 'google' AND mode = 'live'",
    );
    await expect(
      run(
        f.kit.env.DB,
        "UPDATE wallet_provider_releases SET state = 'dark', changed_at = 2 WHERE provider = 'google' AND mode = 'live'",
      ),
    ).rejects.toThrow('drain it first');
    await withoutTrigger(f.kit.env.DB, 'wallet_provider_releases_dark_retired', () =>
      run(f.kit.env.DB, "UPDATE wallet_provider_releases SET state = 'dark', changed_at = 0"),
    );
  });

  it('calls Google for nothing once dark', async () => {
    const { f, jobCtx, scope, google } = await draining();
    restore.push(setWalletReleaseForTest('dark', { provider: 'google', mode: 'live' }));
    const before = google().length;
    await voidPass(jobCtx, system, f.pass.id, scope);
    await drainWalletProviderSync(jobCtx);
    expect(google()).toHaveLength(before);
  });
});

// The cases above run on a database with four guards dropped (google-runtime-test-fixtures). This one keeps every
// guard, so the table's own draining rules run beside the code's, on both account models.
describe.each([
  ['a legacy envelope', false],
  ['an enrolment', true],
] as const)('Google draining with every database guard in place, on %s', (_model, enrolled) => {
  it('issues while released, then refuses an edit and a new link and still sends a void', async () => {
    const { f } = await fixture(undefined, { enrolled, guards: true });
    const token = await tokenOf(f);
    await issueWalletOffer(f.kit.ctx, token, 'google');
    expect(object()).toMatchObject({ state: 'ACTIVE' });
    restore.push(setWalletReleaseForTest('draining', { provider: 'google', mode: 'live' }));
    await releaseRows(f.kit.env.DB, 'draining');
    const jobCtx = jobCtxOf(f.kit);
    const scope = { orgId: f.kit.org.id, mode: 'live', principal: 'session' } as const;
    const sent = () =>
      mock.requests.filter((r) => r.path.includes('walletobjects')).map((r) => r.method);
    const before = sent().length;
    await updatePass(
      jobCtx,
      system,
      f.pass.id,
      { input: { memberName: 'Edited' } },
      { scope: null },
    );
    await drainWalletProviderSync(jobCtx);
    expect(sent()).toHaveLength(before);
    expect(await listWalletOffers(f.kit.ctx, f.pass.id)).toEqual([]);
    await expect(issueWalletOffer(f.kit.ctx, token, 'google')).rejects.toThrow();
    await voidPass(jobCtx, system, f.pass.id, scope);
    await drainWalletProviderSync(jobCtx);
    expect(sent().slice(before)).toContain('PUT');
    expect(sent().slice(before)).not.toContain('PATCH');
    expect(object()).toMatchObject({ state: 'INACTIVE' });
  });
});

describe('the database guards on operations and activation, on an enrolment', () => {
  const setDark = (db: D1Database) =>
    withoutTrigger(db, 'wallet_provider_releases_dark_retired', () => releaseRows(db, 'dark'));

  it('refuses an un-void while draining', async () => {
    const { f } = await fixture(undefined, { enrolled: true, guards: true });
    const db = f.kit.env.DB;
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    const jobCtx = jobCtxOf(f.kit);
    await voidPass(jobCtx, system, f.pass.id, {
      orgId: f.kit.org.id,
      mode: 'live',
      principal: 'session',
    });
    await drainWalletProviderSync(jobCtx);
    expect(object()).toMatchObject({ state: 'INACTIVE' });
    await releaseRows(db, 'draining');
    await expect(
      run(
        db,
        "UPDATE wallet_provider_instances SET lifecycle = 'active' WHERE pass_id = ? AND provider = 'google'",
        [f.pass.id],
      ),
    ).rejects.toThrow('provider issuance is unavailable');
  });

  it('refuses an upsert while the provider is not released, and one for an org that is held', async () => {
    const { f } = await fixture(undefined, { enrolled: true, guards: true });
    const db = f.kit.env.DB;
    const orgId = f.kit.org.id;
    await issueWalletOffer(f.kit.ctx, await tokenOf(f), 'google');
    const keyset = await requireCredentialRefKeyset(db, f.kit.env);
    const release = await first<{ id: string }>(
      db,
      "SELECT id FROM template_releases WHERE provider = 'google' AND source = 'approved' ORDER BY generation DESC LIMIT 1",
    );
    // A ready placeholder for a second pass, as a transfer leaves one.
    const next = await f.kit.pass({ holderEmail: 'placeholder@example.test' });
    const instanceId = f.kit.ctx.ids.id();
    await run(
      db,
      `INSERT INTO wallet_provider_instances (id, pass_id, org_id, mode, provider, credential_generation,
        lifecycle, desired_version, created_at, updated_at, credential_keyset_commitment)
       SELECT ?, p.id, p.org_id, p.mode, 'google', p.credential_generation, 'ready', 0, ?, ?, ?
       FROM passes p WHERE p.id = ?`,
      [instanceId, f.kit.clock.now(), f.kit.clock.now(), keyset, next.id],
    );
    const firstUpsert = async () =>
      run(
        db,
        `INSERT INTO wallet_provider_instance_operations (id, instance_id, version, kind, request_hash,
          pass_version, pass_revision, pass_credential_generation, lifecycle_generation, issuing_release_id,
          projection_release_id, account_revision, adapter_revision, policy_revision, created_at,
          credential_keyset_commitment, pass_row_version, account_epoch, credential_version_id)
         SELECT ?, ?, 1, 'upsert', ?, p.version, p.revision, p.credential_generation, p.lifecycle_generation,
           p.release_id, ?, a.enrolment_revision, 1, 1, ?, ?, p.row_version, a.authority_epoch,
           (SELECT sc.current_version_id FROM wallet_credentials sc WHERE sc.id = a.credential_source_id)
         FROM passes p JOIN wallet_provider_accounts a
           ON a.org_id = p.org_id AND a.mode = p.mode AND a.provider = 'google'
         WHERE p.id = ?`,
        [
          f.kit.ctx.ids.id(),
          instanceId,
          await sha256Hex(f.kit.ctx.ids.token(32)),
          release?.id ?? '',
          f.kit.clock.now(),
          keyset,
          next.id,
        ],
      );
    await setDark(db);
    await expect(firstUpsert()).rejects.toThrow('provider is not released');
    await releaseRows(db);
    // Held: the operation guard's own account proof refuses, though the provider is released.
    await withoutTrigger(db, 'wallet_enrolments_step', () =>
      run(db, 'UPDATE wallet_provider_accounts SET platform_hold_at = 1 WHERE org_id = ?', [orgId]),
    );
    await expect(firstUpsert()).rejects.toThrow('provider operation is not authorized');
    await withoutTrigger(db, 'wallet_enrolments_step', () =>
      run(db, 'UPDATE wallet_provider_accounts SET platform_hold_at = NULL WHERE org_id = ?', [
        orgId,
      ]),
    );
    await firstUpsert();
    expect(
      await first(
        db,
        'SELECT 1 AS n FROM wallet_provider_instance_operations WHERE instance_id = ?',
        [instanceId],
      ),
    ).toEqual({ n: 1 });
  });
});
