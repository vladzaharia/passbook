import { first } from '../../platform/db.ts';

export function assetGrantCredentialRefs(db: D1Database, tokenHash: string) {
  return first<{ credential_refs: string }>(
    db,
    'SELECT credential_refs FROM scan_asset_grant_provenance WHERE token_hash = ?',
    [tokenHash],
  );
}

export function assetGrantProvenance(db: D1Database, tokenHash: string) {
  return first(db, 'SELECT * FROM scan_asset_grant_provenance WHERE token_hash = ?', [tokenHash]);
}
