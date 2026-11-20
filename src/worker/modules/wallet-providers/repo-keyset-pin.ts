/** The immutable keyset singleton the entry already pinned: the value stored in, and matched against, provider rows. */
export const pinnedKeysetSql = '(SELECT commitment FROM credential_ref_keyset WHERE id = 1)';
