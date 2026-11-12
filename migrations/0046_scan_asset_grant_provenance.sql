CREATE TABLE scan_asset_grant_provenance (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  org_id TEXT NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK(mode IN ('live','test')),
  expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at >= 0),
  credential_refs TEXT NOT NULL CHECK(
    CASE WHEN json_valid(credential_refs)
      THEN json_type(credential_refs) = 'array' AND json_array_length(credential_refs) <= 3
      ELSE 0 END
  )
);
CREATE INDEX scan_asset_grant_provenance_expiry ON scan_asset_grant_provenance(expires_at);

-- Provenance is immutable; only expiry cleanup or organization deletion may remove a row.
CREATE TRIGGER scan_asset_grant_provenance_immutable BEFORE UPDATE ON scan_asset_grant_provenance
BEGIN
  SELECT RAISE(ABORT, 'immutable scan asset grant');
END;

CREATE TRIGGER scan_asset_grant_provenance_refs BEFORE INSERT ON scan_asset_grant_provenance
WHEN json_valid(NEW.credential_refs) AND (
  EXISTS(SELECT 1 FROM json_each(NEW.credential_refs)
    WHERE type != 'text' OR length(value) != 64 OR value GLOB '*[^0-9a-f]*')
  OR (SELECT count(*) FROM json_each(NEW.credential_refs)) !=
     (SELECT count(DISTINCT value) FROM json_each(NEW.credential_refs))
)
BEGIN
  SELECT RAISE(ABORT, 'invalid scan asset grant refs');
END;

-- Every minted grant expires exactly one hour after its injected request clock.
CREATE TRIGGER scan_asset_grant_provenance_cleanup AFTER INSERT ON scan_asset_grant_provenance
BEGIN
  DELETE FROM scan_asset_grant_provenance WHERE token_hash IN (
    SELECT token_hash FROM scan_asset_grant_provenance
    WHERE expires_at <= NEW.expires_at - 3600000 ORDER BY expires_at, token_hash LIMIT 100
  );
END;
