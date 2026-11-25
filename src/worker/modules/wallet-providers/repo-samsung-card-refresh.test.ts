import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { selectSamsungCardsToRefresh } from './repo-samsung-card-state.ts';
import { platformSource } from './wallet-roundtrip-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

describe('Samsung card refresh selection', () => {
  it('skips an Off, held or revoked-source enrolment and takes it once it issues', async () => {
    const f = await setupWalletOfferKit({ google: 'absent', samsung: 'published' });
    const orgId = f.kit.org.id;
    const select = async () =>
      (await selectSamsungCardsToRefresh(env.DB, f.kit.clock.now(), 60_000, 50)).map((c) => c.id);
    const candidate = f.samsungRelease?.candidateId ?? '';
    // The published release holds a fresh card read; clear it so the card is due.
    await run(env.DB, 'DELETE FROM wallet_samsung_card_state WHERE candidate_id = ?', [candidate]);
    expect(await select()).toContain(candidate);

    for (const { name } of await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wallet_provider_accounts'",
    ))
      await run(env.DB, `DROP TRIGGER ${name}`);
    const set = (sql: string) =>
      run(
        env.DB,
        `UPDATE wallet_provider_accounts SET ${sql} WHERE org_id = ? AND provider = 'samsung' AND mode = 'live'`,
        [orgId],
      );
    // A new-model enrolment: a platform source, no legacy envelope.
    f.kit.clock.set(Date.now());
    const source = await platformSource(f, 'live', 'card993', 'samsung');
    await set(
      `credential_source_id = '${source.id}', credential_id = NULL, revision = 0, enabled_at = NULL, enrolment_revision = 1`,
    );
    expect(await select()).not.toContain(candidate);
    await set('enabled_at = 1, platform_hold_at = 1');
    expect(await select()).not.toContain(candidate);
    await set('platform_hold_at = NULL');
    expect(await select()).toContain(candidate);
    for (const { name } of await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wallet_credentials'",
    ))
      await run(env.DB, `DROP TRIGGER ${name}`);
    await run(env.DB, 'UPDATE wallet_credentials SET revoked_at = 1 WHERE id = ?', [source.id]);
    expect(await select()).not.toContain(candidate);
  });
});
