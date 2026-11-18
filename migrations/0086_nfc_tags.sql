-- NFC tags (Basic, UID only): third-party tags bound to one pass or one user.
-- No raw UID at rest: tag_ref is a keyed HMAC per org and mode, hint its first four hex digits.
-- `kind` keeps 'sun' for a later package; a trigger refuses it until then.

CREATE TABLE nfc_tags (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  tag_ref TEXT NOT NULL CHECK (length(tag_ref) = 64 AND tag_ref NOT GLOB '*[^0-9a-f]*'),
  kind TEXT NOT NULL CHECK (kind IN ('uid', 'sun')),
  hint TEXT NOT NULL CHECK (length(hint) = 4 AND hint NOT GLOB '*[^0-9A-F]*' AND hint = upper(substr(tag_ref, 1, 4))),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  status_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  UNIQUE (org_id, mode, tag_ref)
);
CREATE INDEX nfc_tags_list ON nfc_tags (org_id, mode, id DESC);

CREATE TRIGGER nfc_tags_kind_insert BEFORE INSERT ON nfc_tags WHEN NEW.kind <> 'uid'
BEGIN SELECT RAISE(ABORT, 'tag_kind_unsupported'); END;
CREATE TRIGGER nfc_tags_fixed BEFORE UPDATE OF id, org_id, mode, tag_ref, kind, hint, created_at ON nfc_tags
BEGIN SELECT RAISE(ABORT, 'tag_fixed_columns'); END;

CREATE TABLE tag_bindings (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL REFERENCES nfc_tags (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('pass', 'user')),
  -- Pass scope: the pass. User scope: the anchor, a pass the user owns in the tag's org and mode.
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('scanner', 'remote', 'admin')),
  bound_at INTEGER NOT NULL,
  bound_by_type TEXT NOT NULL CHECK (bound_by_type IN ('user', 'staff', 'scanner')),
  bound_by TEXT NOT NULL,
  scanner_id TEXT,
  ended_at INTEGER,
  ended_by_type TEXT CHECK (ended_by_type IS NULL OR ended_by_type IN ('user', 'staff', 'scanner', 'system')),
  ended_by TEXT,
  end_cause TEXT CHECK (end_cause IS NULL OR end_cause IN ('admin', 'staff', 'undo', 'lost', 'replaced', 'moved',
    'holder_changed', 'pass_deleted', 'no_passes', 'offboard', 'pass_ended', 'tag_retired')),
  CHECK ((scope = 'user') = (user_id IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_cause IS NULL) AND (ended_at IS NULL) = (ended_by_type IS NULL))
);
CREATE UNIQUE INDEX tag_bindings_active ON tag_bindings (tag_id) WHERE ended_at IS NULL;
CREATE INDEX tag_bindings_pass ON tag_bindings (pass_id, ended_at);
CREATE INDEX tag_bindings_user ON tag_bindings (user_id, ended_at) WHERE user_id IS NOT NULL;
CREATE INDEX tag_bindings_tag_last ON tag_bindings (tag_id, ended_at);

-- Insert: the tag is active, tag and pass share org and mode, a user binding is anchored on a pass the user
-- owns, and at most 4 active pass bindings per pass and 4 active user bindings per (user, org, mode).
CREATE TRIGGER tag_bindings_insert_check BEFORE INSERT ON tag_bindings
BEGIN
  SELECT RAISE(ABORT, 'tag_binding_ended') WHERE NEW.ended_at IS NOT NULL;
  SELECT RAISE(ABORT, 'tag_retired') WHERE EXISTS (SELECT 1 FROM nfc_tags t WHERE t.id = NEW.tag_id AND t.status <> 'active');
  SELECT RAISE(ABORT, 'tag_binding_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tags t JOIN passes p ON p.org_id = t.org_id AND p.mode = t.mode
    WHERE t.id = NEW.tag_id AND p.id = NEW.pass_id AND p.deleted_at IS NULL);
  SELECT RAISE(ABORT, 'tag_binding_owner') WHERE NEW.scope = 'user'
    AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.owner_user_id = NEW.user_id);
  SELECT RAISE(ABORT, 'tag_binding_limit') WHERE NEW.scope = 'pass'
    AND (SELECT count(*) FROM tag_bindings b WHERE b.pass_id = NEW.pass_id AND b.scope = 'pass' AND b.ended_at IS NULL) >= 4;
  SELECT RAISE(ABORT, 'tag_binding_limit') WHERE NEW.scope = 'user'
    AND (SELECT count(*) FROM tag_bindings b JOIN nfc_tags bt ON bt.id = b.tag_id JOIN nfc_tags nt ON nt.id = NEW.tag_id
      WHERE b.user_id = NEW.user_id AND b.scope = 'user' AND b.ended_at IS NULL
        AND bt.org_id = nt.org_id AND bt.mode = nt.mode) >= 4;
END;

-- Update: a binding ends once, or a user binding moves its anchor to another pass of the same owner, org and mode.
CREATE TRIGGER tag_bindings_update_check BEFORE UPDATE ON tag_bindings
BEGIN
  SELECT RAISE(ABORT, 'tag_binding_immutable') WHERE OLD.ended_at IS NOT NULL
    OR NEW.id IS NOT OLD.id OR NEW.tag_id IS NOT OLD.tag_id OR NEW.scope IS NOT OLD.scope
    OR NEW.user_id IS NOT OLD.user_id OR NEW.source IS NOT OLD.source OR NEW.bound_at IS NOT OLD.bound_at
    OR NEW.bound_by_type IS NOT OLD.bound_by_type OR NEW.bound_by IS NOT OLD.bound_by
    OR NEW.scanner_id IS NOT OLD.scanner_id
    OR (NEW.ended_at IS NOT NULL AND NEW.pass_id IS NOT OLD.pass_id);
  SELECT RAISE(ABORT, 'tag_binding_reanchor') WHERE NEW.pass_id IS NOT OLD.pass_id AND NOT EXISTS (
    SELECT 1 FROM passes p JOIN nfc_tags t ON t.id = NEW.tag_id
    WHERE p.id = NEW.pass_id AND NEW.scope = 'user' AND p.owner_user_id = NEW.user_id
      AND p.org_id = t.org_id AND p.mode = t.mode AND p.deleted_at IS NULL);
END;

-- A pass that changes holder, is deleted or leaves its org or mode drops its pass bindings; a user binding
-- anchored on it moves to the user's oldest other pass in that org and mode, or ends.
CREATE TRIGGER passes_tag_bindings_follow AFTER UPDATE OF holder_email, owner_user_id, deleted_at, org_id, mode ON passes
WHEN EXISTS (SELECT 1 FROM tag_bindings b WHERE b.pass_id = NEW.id AND b.ended_at IS NULL)
BEGIN
  UPDATE tag_bindings SET ended_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000, ended_by_type = 'system',
    ended_by = 'passes', end_cause = CASE WHEN NEW.deleted_at IS NOT NULL THEN 'pass_deleted' ELSE 'holder_changed' END
  WHERE pass_id = NEW.id AND scope = 'pass' AND ended_at IS NULL
    AND (NEW.deleted_at IS NOT NULL OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
      OR NEW.holder_email IS NOT OLD.holder_email
      OR (OLD.owner_user_id IS NOT NULL AND NEW.owner_user_id IS NOT OLD.owner_user_id));
  UPDATE tag_bindings SET pass_id = (
    SELECT p2.id FROM passes p2 JOIN nfc_tags t ON t.id = tag_bindings.tag_id
    WHERE p2.owner_user_id = tag_bindings.user_id AND p2.org_id = t.org_id AND p2.mode = t.mode
      AND p2.deleted_at IS NULL AND p2.id <> NEW.id ORDER BY p2.created_at, p2.id LIMIT 1)
  WHERE pass_id = NEW.id AND scope = 'user' AND ended_at IS NULL
    AND (NEW.deleted_at IS NOT NULL OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
      OR NEW.owner_user_id IS NOT tag_bindings.user_id)
    AND EXISTS (SELECT 1 FROM passes p2 JOIN nfc_tags t ON t.id = tag_bindings.tag_id
      WHERE p2.owner_user_id = tag_bindings.user_id AND p2.org_id = t.org_id AND p2.mode = t.mode
        AND p2.deleted_at IS NULL AND p2.id <> NEW.id);
  UPDATE tag_bindings SET ended_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000, ended_by_type = 'system',
    ended_by = 'passes', end_cause = 'no_passes'
  WHERE pass_id = NEW.id AND scope = 'user' AND ended_at IS NULL
    AND (NEW.deleted_at IS NOT NULL OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
      OR NEW.owner_user_id IS NOT tag_bindings.user_id);
END;

-- The tag a scan was read from. Not a foreign key: proof outlives the tag.
ALTER TABLE scans ADD COLUMN tag_id TEXT;
