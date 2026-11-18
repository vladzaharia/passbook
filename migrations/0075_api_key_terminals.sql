-- A `scans:write` key acts only as the terminals it was minted for. The binding is written with the key and
-- never changes: a new set of terminals is a new key. It goes away only with its key or terminal (the org cascade).
CREATE TABLE api_key_terminals (
  key_id TEXT NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  scanner_id TEXT NOT NULL REFERENCES scanners (id) ON DELETE CASCADE,
  PRIMARY KEY (key_id, scanner_id)
) WITHOUT ROWID;
CREATE INDEX api_key_terminals_scanner ON api_key_terminals (scanner_id);

CREATE TRIGGER api_key_terminals_immutable BEFORE UPDATE ON api_key_terminals
BEGIN SELECT RAISE(ABORT, 'api key terminals are immutable'); END;

-- A key that has been used, or revoked, gains no terminals.
CREATE TRIGGER api_key_terminals_new_key_only BEFORE INSERT ON api_key_terminals
WHEN EXISTS (SELECT 1 FROM api_keys k WHERE k.id = NEW.key_id AND (k.last_used_at IS NOT NULL OR k.revoked_at IS NOT NULL))
  OR NOT EXISTS (SELECT 1 FROM api_keys k, scanners s WHERE k.id = NEW.key_id AND s.id = NEW.scanner_id
    AND s.org_id = k.org_id AND s.mode = k.mode AND s.kind = 'terminal')
BEGIN SELECT RAISE(ABORT, 'a key is bound to terminals of its own org and mode when minted'); END;

CREATE TRIGGER api_key_terminals_no_delete BEFORE DELETE ON api_key_terminals
WHEN EXISTS (SELECT 1 FROM api_keys k WHERE k.id = OLD.key_id) AND EXISTS (SELECT 1 FROM scanners s WHERE s.id = OLD.scanner_id)
BEGIN SELECT RAISE(ABORT, 'api key terminals are immutable'); END;

-- The key a scan was made with (a till scanning as one of the key's terminals). Set when the scan is claimed.
ALTER TABLE scans ADD COLUMN api_key_id TEXT;
CREATE INDEX scans_api_key ON scans (api_key_id, at DESC) WHERE api_key_id IS NOT NULL;
