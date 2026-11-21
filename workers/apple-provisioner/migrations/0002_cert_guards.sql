-- Certificates the provisioner ordered, and whether the main Worker has reported them active.
-- Mutable on purpose: `activated_at` is set once. The ledger stays append-only.
CREATE TABLE asc_certificates (
  cert_id TEXT PRIMARY KEY,
  pass_type_asc_id TEXT NOT NULL,
  ordered_at INTEGER NOT NULL,
  activated_at INTEGER
) STRICT;

CREATE INDEX asc_certificates_type ON asc_certificates (pass_type_asc_id, ordered_at);

-- One row per revocation the provisioner let through, for the weekly per-type limit.
CREATE TABLE asc_revocations (
  cert_id TEXT PRIMARY KEY,
  pass_type_asc_id TEXT NOT NULL,
  at INTEGER NOT NULL
) STRICT;

CREATE INDEX asc_revocations_type ON asc_revocations (pass_type_asc_id, at);
