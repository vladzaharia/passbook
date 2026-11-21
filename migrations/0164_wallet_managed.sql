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
-- state: pending (made, not yet in a credential), active (a credential holds it), retiring (replaced,
-- deleted after the cooldown), retired (deleted).
CREATE TABLE wallet_sa_keys (
  key_name TEXT PRIMARY KEY,
  credential_id TEXT NOT NULL REFERENCES wallet_credentials (id),
  origin TEXT NOT NULL DEFAULT 'created' CHECK (origin IN ('created', 'adopted')),
  state TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('pending', 'active', 'retiring', 'retired')),
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX wallet_sa_keys_credential ON wallet_sa_keys (credential_id);

-- Who holds a Google issuer, across modes and for good. A row is never deleted or handed to another org
-- except through a claim that proves ownership. No foreign key: the claim survives an org purge.
-- origin: created (PassBook made it), shared (the org's own, proven by an owner email), manual (an admin entered it).
CREATE TABLE wallet_google_issuers (
  issuer_id TEXT PRIMARY KEY CHECK (issuer_id NOT GLOB '*[^0-9]*' AND length(issuer_id) BETWEEN 1 AND 32),
  org_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK (origin IN ('created', 'shared', 'manual')),
  claimed_at INTEGER NOT NULL
);
CREATE INDEX wallet_google_issuers_org ON wallet_google_issuers (org_id);
CREATE TRIGGER wallet_google_issuers_no_delete BEFORE DELETE ON wallet_google_issuers
BEGIN
  SELECT RAISE(ABORT, 'WALLET_ISSUER_CLAIM_KEPT');
END;
CREATE TRIGGER wallet_google_issuers_no_replace BEFORE INSERT ON wallet_google_issuers
WHEN EXISTS (SELECT 1 FROM wallet_google_issuers WHERE issuer_id = NEW.issuer_id)
BEGIN
  SELECT RAISE(IGNORE);
END;

-- A run is claimed by one job at a time: the lease expires, so a crashed holder's run is picked up again.
ALTER TABLE identity_runs ADD COLUMN lease_until INTEGER;

-- A developer org holds no Live row, whoever writes it (0156).
CREATE TRIGGER wallet_org_cards_developer_no_live BEFORE INSERT ON wallet_org_cards
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
