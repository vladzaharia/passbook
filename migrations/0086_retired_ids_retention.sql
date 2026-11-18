-- Retired ids are kept 400 days (longer than any session, scanner or key could still present one), then purged.
-- Rebuilt so each row carries its retirement time; existing rows start their window at this migration.
DROP TABLE retired_session_ids;
CREATE TABLE retired_session_ids (
  id_hash TEXT PRIMARY KEY NOT NULL,
  retired_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX retired_session_ids_retired_at ON retired_session_ids (retired_at);
CREATE TRIGGER retired_session_ids_no_replace BEFORE INSERT ON retired_session_ids
WHEN EXISTS (SELECT 1 FROM retired_session_ids WHERE id_hash = NEW.id_hash)
BEGIN
  SELECT RAISE(ABORT, 'retired session ID is immutable');
END;
CREATE TRIGGER retired_session_ids_no_update BEFORE UPDATE ON retired_session_ids
BEGIN
  SELECT RAISE(ABORT, 'retired session ID is immutable');
END;
CREATE TRIGGER retired_session_ids_no_delete BEFORE DELETE ON retired_session_ids
WHEN OLD.retired_at > CAST(unixepoch('subsec') * 1000 AS INTEGER) - 34560000000
BEGIN
  SELECT RAISE(ABORT, 'retired session ID is immutable');
END;

DROP TABLE retired_scanner_ids;
CREATE TABLE retired_scanner_ids (
  id TEXT PRIMARY KEY NOT NULL,
  retired_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX retired_scanner_ids_retired_at ON retired_scanner_ids (retired_at);
CREATE TRIGGER retired_scanner_ids_no_replace BEFORE INSERT ON retired_scanner_ids
WHEN EXISTS (SELECT 1 FROM retired_scanner_ids WHERE id = NEW.id)
BEGIN
  SELECT RAISE(ABORT, 'retired scanner ID is immutable');
END;
CREATE TRIGGER retired_scanner_ids_no_update BEFORE UPDATE ON retired_scanner_ids
BEGIN
  SELECT RAISE(ABORT, 'retired scanner ID is immutable');
END;
CREATE TRIGGER retired_scanner_ids_no_delete BEFORE DELETE ON retired_scanner_ids
WHEN OLD.retired_at > CAST(unixepoch('subsec') * 1000 AS INTEGER) - 34560000000
BEGIN
  SELECT RAISE(ABORT, 'retired scanner ID is immutable');
END;

DROP TABLE retired_api_key_ids;
CREATE TABLE retired_api_key_ids (
  id TEXT PRIMARY KEY,
  retired_at INTEGER NOT NULL DEFAULT (CAST(unixepoch('subsec') * 1000 AS INTEGER))
);
CREATE INDEX retired_api_key_ids_retired_at ON retired_api_key_ids (retired_at);
CREATE TRIGGER retired_api_key_ids_no_update BEFORE UPDATE ON retired_api_key_ids
BEGIN SELECT RAISE(ABORT, 'retired API key ID is immutable'); END;
CREATE TRIGGER retired_api_key_ids_no_delete BEFORE DELETE ON retired_api_key_ids
WHEN OLD.retired_at > CAST(unixepoch('subsec') * 1000 AS INTEGER) - 34560000000
BEGIN SELECT RAISE(ABORT, 'retired API key ID is immutable'); END;
