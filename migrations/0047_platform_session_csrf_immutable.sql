-- A session's CSRF secret is permanent; rotation requires a new session ID.
CREATE TRIGGER sessions_csrf_secret_immutable BEFORE UPDATE OF csrf_secret ON sessions
BEGIN
  SELECT RAISE(ABORT, 'session csrf secret is immutable');
END;

-- Session authority is bound to its original identity and absolute lifetime.
CREATE TRIGGER sessions_authority_immutable BEFORE UPDATE ON sessions
WHEN NEW.id_hash IS NOT OLD.id_hash OR NEW.user_id IS NOT OLD.user_id
  OR NEW.created_at IS NOT OLD.created_at OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.roles IS NOT OLD.roles OR NEW.amr IS NOT OLD.amr
BEGIN
  SELECT RAISE(ABORT, 'session authority is immutable');
END;

-- Retain only the hash after deletion, including user-delete cascades, to prevent ID reuse.
CREATE TABLE retired_session_ids (id_hash TEXT PRIMARY KEY NOT NULL);
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
BEGIN
  SELECT RAISE(ABORT, 'retired session ID is immutable');
END;
CREATE TRIGGER sessions_retire_id AFTER DELETE ON sessions
BEGIN
  INSERT INTO retired_session_ids (id_hash) VALUES (OLD.id_hash);
END;

-- REPLACE bypasses update triggers; neither live nor retired IDs may be inserted again.
CREATE TRIGGER sessions_no_replace BEFORE INSERT ON sessions
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM sessions WHERE id_hash = NEW.id_hash)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: sessions.id_hash') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM retired_session_ids WHERE id_hash = NEW.id_hash)
    THEN RAISE(ABORT, 'session ID is retired') END;
END;

-- Credential changes must advance the revision used by scanner authority proofs.
CREATE TRIGGER scanners_credential_revision BEFORE UPDATE ON scanners
WHEN NEW.updated_at < OLD.updated_at
  OR ((NEW.csrf_secret IS NOT OLD.csrf_secret OR NEW.token_hash IS NOT OLD.token_hash
    OR NEW.token_prefix IS NOT OLD.token_prefix) AND NEW.updated_at <= OLD.updated_at)
BEGIN
  SELECT RAISE(ABORT, 'scanner credential revision must advance');
END;

-- Deleted IDs remain reserved even when deletion cascades from an organization.
CREATE TABLE retired_scanner_ids (id TEXT PRIMARY KEY NOT NULL);
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
BEGIN
  SELECT RAISE(ABORT, 'retired scanner ID is immutable');
END;
CREATE TRIGGER scanners_retire_id AFTER DELETE ON scanners
BEGIN
  INSERT INTO retired_scanner_ids (id) VALUES (OLD.id);
END;
CREATE TRIGGER scanners_id_immutable BEFORE UPDATE OF id ON scanners
WHEN NEW.id IS NOT OLD.id
BEGIN
  SELECT RAISE(ABORT, 'scanner ID is immutable');
END;

-- REPLACE can evict a scanner through any of its unique keys, resetting its revision.
CREATE TRIGGER scanners_revision_no_replace BEFORE INSERT ON scanners
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scanners WHERE id = NEW.id)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.id') END;
  SELECT CASE WHEN EXISTS (SELECT 1 FROM retired_scanner_ids WHERE id = NEW.id)
    THEN RAISE(ABORT, 'scanner ID is retired') END;
  SELECT CASE WHEN NEW.token_prefix IS NOT NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE token_prefix = NEW.token_prefix)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.token_prefix') END;
  SELECT CASE WHEN NEW.pair_code_hash IS NOT NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE pair_code_hash = NEW.pair_code_hash)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.pair_code_hash') END;
  SELECT CASE WHEN NEW.revoked_at IS NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE org_id = NEW.org_id AND mode = NEW.mode
      AND name = NEW.name COLLATE NOCASE AND revoked_at IS NULL)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.org_id, scanners.mode, scanners.name') END;
END;

CREATE TRIGGER scanners_revision_no_replace_update BEFORE UPDATE ON scanners
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM scanners WHERE id = NEW.id AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.id') END;
  SELECT CASE WHEN NEW.token_prefix IS NOT NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE token_prefix = NEW.token_prefix AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.token_prefix') END;
  SELECT CASE WHEN NEW.pair_code_hash IS NOT NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE pair_code_hash = NEW.pair_code_hash AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.pair_code_hash') END;
  SELECT CASE WHEN NEW.revoked_at IS NULL AND EXISTS
    (SELECT 1 FROM scanners WHERE org_id = NEW.org_id AND mode = NEW.mode
      AND name = NEW.name COLLATE NOCASE AND revoked_at IS NULL AND rowid != OLD.rowid)
    THEN RAISE(ABORT, 'UNIQUE constraint failed: scanners.org_id, scanners.mode, scanners.name') END;
END;
