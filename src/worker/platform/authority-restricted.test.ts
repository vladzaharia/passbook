import { describe, expect, it } from 'vitest';
import { INSERT_ONLY_PURPOSES, RESTRICTED_TABLES } from './authority-restricted.ts';

const KEYSET = ['create', 'rotate', 'retire_key', 'revoke_key', 'disable'].map(
  (p) => `org_mode.nfc.keyset.${p}`,
);

describe('assembled restricted tables', () => {
  it('match the lists before the split', () => {
    expect(RESTRICTED_TABLES).toEqual({
      wallet_credential_checks: ['platform.job.wallet.credential_check'],
      org_entitlements: [
        'platform.org.create',
        'platform.org.personal',
        'platform.org.create_admin',
        'platform.job.template_sync',
        'platform.job.developer_sandbox.create',
        'platform.org.entitlements_set',
        'org.job.entitlement_expiry',
      ],
      org_entitlement_overrides: ['platform.org.entitlements_set', 'org.job.entitlement_expiry'],
      entitlement_preset_meta: ['platform.entitlement_preset.update'],
      entitlement_presets: ['platform.entitlement_preset.update'],
      nfc_tag_keysets: KEYSET,
      nfc_tag_keys: KEYSET,
    });
    expect(INSERT_ONLY_PURPOSES).toEqual({
      org_entitlements: [
        'platform.job.template_sync',
        'platform.job.developer_sandbox.create',
        'platform.org.create',
        'platform.org.personal',
        'platform.org.create_admin',
      ],
    });
  });
});
