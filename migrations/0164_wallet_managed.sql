-- Managed wallet identities, Google: who runs a credential and when its key rotates.
-- provenance: platform (PassBook's own), managed (a child issuer PassBook made), own (the org's issuer).
ALTER TABLE wallet_credentials ADD COLUMN provenance TEXT NOT NULL DEFAULT 'own'
  CHECK (provenance IN ('platform', 'managed', 'own'));
-- The credential whose service-account key signs for this one; its key rotation fans out here.
ALTER TABLE wallet_credentials ADD COLUMN signer_ref TEXT REFERENCES wallet_credentials (id);
-- A platform credential's next service-account key rotation; NULL until the first one succeeds.
ALTER TABLE wallet_credentials ADD COLUMN next_rotation_at INTEGER;
UPDATE wallet_credentials SET provenance = 'platform' WHERE scope = 'platform';
CREATE INDEX wallet_credentials_signer ON wallet_credentials (signer_ref) WHERE signer_ref IS NOT NULL;
CREATE INDEX wallet_credentials_rotation_due ON wallet_credentials (next_rotation_at)
  WHERE next_rotation_at IS NOT NULL AND revoked_at IS NULL;

-- Samsung cards per org on the platform partner (filled by the Samsung package).
CREATE TABLE wallet_org_cards (
  org_id TEXT NOT NULL REFERENCES orgs (id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  card_type TEXT NOT NULL,
  card_id TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('draft', 'verifying', 'active', 'rejected', 'retired')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, mode, card_type)
);

-- Service-account keys PassBook created or adopted ('adopted': the one key found at the first rotation).
-- The inventory compares Google's key list with this table.
CREATE TABLE wallet_sa_keys (
  key_name TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES wallet_credentials (id),
  origin TEXT NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'adopted')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX wallet_sa_keys_credential ON wallet_sa_keys (credential_id);
