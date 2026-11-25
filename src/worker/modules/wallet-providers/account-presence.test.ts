import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { all, run } from '../../platform/db.ts';
import { hasCredential, hasCredentialSql } from './account-presence.ts';
import { getWalletProviderReadiness } from './account-service.ts';
import { setupWalletOfferKit } from './offers-test-fixtures.ts';
import { setWalletProvidersEnabledForTest } from './provider-policy.ts';
import { dropInsertGuards, enrol, platformSource } from './wallet-roundtrip-test-fixtures.ts';

beforeAll(() => {
  setWalletProvidersEnabledForTest(true);
});

const sqlPresent = async (orgId: string, mode: string) =>
  (
    await all<{ id: string }>(
      env.DB,
      `SELECT a.id FROM wallet_provider_accounts a WHERE a.org_id = ? AND a.mode = ? AND a.provider = 'samsung'
       AND ${hasCredentialSql('a')}`,
      [orgId, mode],
    )
  ).length === 1;

describe('credential presence on either model', () => {
  it('hasCredential reads both columns', () => {
    expect(hasCredential({ credential_id: null, credential_source_id: null })).toBe(false);
    expect(hasCredential({ credential_id: null, credential_source_id: null })).toBe(false);
    expect(hasCredential({ credential_id: 'a', credential_source_id: null })).toBe(true);
    expect(hasCredential({ credential_id: null, credential_source_id: 's' })).toBe(true);
    expect(hasCredential({ credential_id: 'a', credential_source_id: 's' })).toBe(true);
  });

  it('old model only, new model only and both read as configured, nothing as absent', async () => {
    const f = await setupWalletOfferKit({
      google: 'absent',
      samsung: 'configured',
      holderEmail: 'h@example.test',
    });
    const { kit } = f;
    kit.clock.set(Date.now());
    const orgId = kit.org.id;
    const scope = (mode: 'live' | 'test') => ({ orgId, mode, provider: 'samsung' as const });

    // Old model only: a legacy envelope in live.
    expect((await getWalletProviderReadiness(kit.ctx, scope('live'))).state).toBe('configured');
    expect(await sqlPresent(orgId, 'live')).toBe(true);

    // Nothing in test yet.
    expect((await getWalletProviderReadiness(kit.ctx, scope('test'))).state).toBe('absent');

    // New model only: an enrolment with a source and no legacy envelope.
    await dropInsertGuards(env.DB);
    const source = await platformSource(f, 'test', 'card992', 'samsung');
    await enrol(f, orgId, 'test', source, false, 'samsung');
    const row = await all<{ credential_id: string | null; credential_source_id: string | null }>(
      env.DB,
      "SELECT credential_id, credential_source_id FROM wallet_provider_accounts WHERE org_id = ? AND mode = 'test' AND provider = 'samsung'",
      [orgId],
    );
    expect(row[0]?.credential_id).toBeNull();
    expect(row[0]?.credential_source_id).not.toBeNull();
    expect((await getWalletProviderReadiness(kit.ctx, scope('test'))).state).toBe('configured');
    expect(await sqlPresent(orgId, 'test')).toBe(true);

    // Both: the legacy row also names a source, as a migrated account does.
    for (const { name } of await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'wallet_provider_accounts'",
    ))
      await run(env.DB, `DROP TRIGGER ${name}`);
    await run(
      env.DB,
      "UPDATE wallet_provider_accounts SET credential_source_id = ? WHERE org_id = ? AND mode = 'live' AND provider = 'samsung'",
      [source.id, orgId],
    );
    expect((await getWalletProviderReadiness(kit.ctx, scope('live'))).state).toBe('configured');
    expect(await sqlPresent(orgId, 'live')).toBe(true);
  });
});
