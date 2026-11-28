import type { RestrictedEntries } from './types.ts';

const KEYSET_PURPOSES = ['create', 'rotate', 'retire_key', 'revoke_key', 'disable'].map(
  (p) => `org_mode.nfc.keyset.${p}`,
);

export const nfcRestricted: RestrictedEntries = {
  restricted: {
    // Secure tag keys (0129): the five keyset purposes only (re-enrol and import write side rows, not keys).
    nfc_tag_keysets: KEYSET_PURPOSES,
    nfc_tag_keys: KEYSET_PURPOSES,
  },
};
