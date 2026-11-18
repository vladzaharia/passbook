-- A holder reports their own tag lost under a holder grant, which lists one more purpose.
-- authority_grants is empty between batches, so the table is rebuilt for its CHECK.
-- This is now the canonical authority_grants definition: a later change to its CHECKs rebuilds it from here.
DROP TABLE authority_grants;
CREATE TABLE authority_grants (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('org', 'org_mode', 'platform')),
  org_id TEXT,
  mode TEXT,
  principal TEXT NOT NULL,
  purpose TEXT NOT NULL,
  target_id TEXT,
  denied TEXT,
  created_at INTEGER NOT NULL,
  leak_guard TEXT NOT NULL REFERENCES authority_grant_leaks(id) DEFERRABLE INITIALLY DEFERRED,
  CHECK ((scope = 'platform' AND org_id IS NULL AND mode IS NULL)
      OR (scope = 'org' AND org_id IS NOT NULL AND mode IS NULL)
      OR (scope = 'org_mode' AND org_id IS NOT NULL AND mode IN ('live', 'test'))),
  CHECK (purpose GLOB scope || '.*'),
  CHECK (leak_guard = id),
  CHECK (purpose NOT GLOB '*.connection.*' OR IFNULL(mode, '') = 'live'),
  CHECK (principal NOT GLOB 'system:*' OR purpose GLOB '*.job.*'),
  CHECK (principal NOT GLOB 'holder:*' OR purpose IN ('org_mode.pass.holder_remove', 'org_mode.pass.holder_attach', 'org_mode.nfc.tag.holder_lost')),
  CHECK (principal NOT GLOB 'device:*' OR purpose = 'org_mode.pass.personalize'),
  CHECK (principal GLOB 'holder:*' OR principal GLOB 'device:*'
    OR purpose NOT IN ('org_mode.pass.holder_remove', 'org_mode.pass.holder_attach', 'org_mode.pass.personalize', 'org_mode.nfc.tag.holder_lost'))
);
CREATE INDEX authority_grants_leak_guard ON authority_grants(leak_guard);
CREATE TRIGGER authority_grants_deny BEFORE INSERT ON authority_grants WHEN NEW.denied IS NOT NULL
BEGIN SELECT CASE NEW.denied
  WHEN 'org' THEN RAISE(ABORT, 'authority_denied:org') WHEN 'actor' THEN RAISE(ABORT, 'authority_denied:actor')
  WHEN 'staff' THEN RAISE(ABORT, 'authority_denied:staff')
  WHEN 'config' THEN RAISE(ABORT, 'authority_denied:config') WHEN 'lineage' THEN RAISE(ABORT, 'authority_denied:lineage')
  WHEN 'stale' THEN RAISE(ABORT, 'authority_denied:stale') WHEN 'release' THEN RAISE(ABORT, 'authority_denied:release')
  WHEN 'retention' THEN RAISE(ABORT, 'authority_denied:retention') ELSE RAISE(ABORT, 'authority_denied:other') END; END;
CREATE TRIGGER authority_grants_immutable BEFORE UPDATE ON authority_grants
BEGIN SELECT RAISE(ABORT, 'authority grant is immutable'); END;

-- Ending a binding as lost marks the tag, whoever ends it: a holder grant cannot write nfc_tags itself.
CREATE TRIGGER tag_bindings_lost_marks AFTER UPDATE OF end_cause ON tag_bindings
WHEN NEW.end_cause = 'lost'
BEGIN
  UPDATE nfc_tags SET lost_at = NEW.ended_at, lost_by = NEW.ended_by WHERE id = NEW.tag_id AND lost_at IS NULL;
END;
CREATE TRIGGER tag_bindings_lost_needs_actor BEFORE UPDATE OF end_cause ON tag_bindings
WHEN NEW.end_cause = 'lost' AND NEW.ended_by IS NULL
BEGIN SELECT RAISE(ABORT, 'tag_lost_needs_actor'); END;
