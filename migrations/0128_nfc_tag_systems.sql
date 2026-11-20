-- NFC tag systems and tag types (design-nfc-tag-systems.md section 1.2, P1).
-- A system is how a tag proves itself (`uid` Basic, `sun` Secure, off until 0129); a type is an org's named policy
-- for tags (use, scopes, per-pass limit, expiry, door confirm, templates). `nfc_tags.kind` becomes
-- `nfc_tags.system` and gains `type_id`; `tag_bindings` gains `expires_at` and four end causes.
--
-- Rebuild, the 0114 pattern. A CHECK, a column rename and a foreign key cannot be changed in place, and D1 keeps
-- foreign keys on, so ALTER TABLE RENAME is out (it rewrites the children) and DROP TABLE would cascade. The
-- closure (nfc_tags <- tag_bindings CASCADE <- tag_enrollments.binding_id SET NULL) is copied to _keep_*, dropped
-- leaf first, recreated parent first and restored column by column; indexes come back with the tables and the
-- triggers after the rows, from their text in 0088, 0095 and 0097. passes_tag_bindings_follow sits on `passes`,
-- so the rebuild does not touch it. tools/nfc-tags-rebuild.test.ts diffs the whole sqlite_master and the rows.
-- It is the last rebuild these tables need: later systems are rows in nfc_tag_systems.

CREATE TABLE nfc_tag_systems (
  id TEXT PRIMARY KEY CHECK (length(id) BETWEEN 2 AND 16 AND id NOT GLOB '*[^a-z0-9]*'),
  assurance TEXT NOT NULL CHECK (assurance IN ('basic', 'secure')),
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
);
INSERT INTO nfc_tag_systems (id, assurance, enabled) VALUES ('uid', 'basic', 1), ('sun', 'secure', 0);

CREATE TABLE nfc_tag_types (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  system TEXT NOT NULL REFERENCES nfc_tag_systems (id),
  use TEXT NOT NULL CHECK (length(use) BETWEEN 2 AND 16 AND use NOT GLOB '*[^a-z_]*'),
  scopes TEXT NOT NULL DEFAULT 'both' CHECK (scopes IN ('pass', 'user', 'both')),
  per_pass INTEGER NOT NULL DEFAULT 1 CHECK (per_pass BETWEEN 1 AND 4),
  binding_days INTEGER CHECK (binding_days IS NULL OR binding_days BETWEEN 1 AND 3650),
  confirm TEXT NOT NULL DEFAULT 'none' CHECK (confirm IN ('none', 'staff', 'manager')),
  typed INTEGER NOT NULL DEFAULT 1 CHECK (typed IN (0, 1)),
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  archived_at INTEGER
);
CREATE UNIQUE INDEX nfc_tag_types_name ON nfc_tag_types (org_id, name) WHERE archived_at IS NULL;
CREATE INDEX nfc_tag_types_org ON nfc_tag_types (org_id, id);
CREATE INDEX nfc_tag_types_system ON nfc_tag_types (system);

-- Templates a type works with; no rows means any template.
CREATE TABLE nfc_tag_type_templates (
  type_id TEXT NOT NULL REFERENCES nfc_tag_types (id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  PRIMARY KEY (type_id, template_id)
);
CREATE INDEX nfc_tag_type_templates_template ON nfc_tag_type_templates (template_id);

-- rebuild:begin
PRAGMA defer_foreign_keys = ON;
CREATE TABLE _keep_nfc_tags AS SELECT * FROM nfc_tags;
CREATE TABLE _keep_tag_bindings AS SELECT * FROM tag_bindings;
CREATE TABLE _keep_tag_enrollments AS SELECT * FROM tag_enrollments;
DROP TABLE tag_enrollments;
DROP TABLE tag_bindings;
DROP TABLE nfc_tags;

CREATE TABLE nfc_tags (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  tag_ref TEXT NOT NULL CHECK (length(tag_ref) = 64 AND tag_ref NOT GLOB '*[^0-9a-f]*'),
  system TEXT NOT NULL REFERENCES nfc_tag_systems (id),
  type_id TEXT REFERENCES nfc_tag_types (id),
  hint TEXT NOT NULL CHECK (length(hint) = 4 AND hint NOT GLOB '*[^0-9A-F]*' AND hint = upper(substr(tag_ref, 1, 4))),
  label TEXT CHECK (label IS NULL OR length(label) BETWEEN 1 AND 40),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  status_at INTEGER,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER,
  lost_at INTEGER,
  lost_by TEXT,
  CHECK ((lost_at IS NULL) = (lost_by IS NULL)),
  UNIQUE (org_id, mode, tag_ref)
);
CREATE INDEX nfc_tags_list ON nfc_tags (org_id, mode, id DESC);
CREATE INDEX nfc_tags_system ON nfc_tags (system);
CREATE INDEX nfc_tags_type ON nfc_tags (type_id) WHERE type_id IS NOT NULL;

CREATE TABLE tag_bindings (
  id TEXT PRIMARY KEY,
  tag_id TEXT NOT NULL REFERENCES nfc_tags (id) ON DELETE CASCADE,
  scope TEXT NOT NULL CHECK (scope IN ('pass', 'user')),
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users (id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('scanner', 'remote', 'admin')),
  bound_at INTEGER NOT NULL,
  bound_by_type TEXT NOT NULL CHECK (bound_by_type IN ('user', 'staff', 'scanner')),
  bound_by TEXT NOT NULL,
  scanner_id TEXT,
  holder_generation INTEGER NOT NULL,
  holder_owner TEXT,
  ended_at INTEGER,
  ended_by_type TEXT CHECK (ended_by_type IS NULL OR ended_by_type IN ('user', 'staff', 'scanner', 'system')),
  ended_by TEXT,
  end_cause TEXT CHECK (end_cause IS NULL OR end_cause IN ('admin', 'staff', 'undo', 'lost', 'replaced', 'moved',
    'holder_changed', 'pass_deleted', 'no_passes', 'offboard', 'pass_ended', 'tag_retired',
    'visitor_out', 'channel_off', 'expired', 'type_changed')),
  idempotency_key TEXT,
  request_hash TEXT,
  cleared_lost_at INTEGER,
  cleared_lost_by TEXT,
  expires_at INTEGER,
  CHECK ((scope = 'user') = (user_id IS NOT NULL)),
  CHECK ((ended_at IS NULL) = (end_cause IS NULL) AND (ended_at IS NULL) = (ended_by_type IS NULL))
);
CREATE UNIQUE INDEX tag_bindings_active ON tag_bindings (tag_id) WHERE ended_at IS NULL;
CREATE INDEX tag_bindings_pass ON tag_bindings (pass_id, ended_at);
CREATE INDEX tag_bindings_user ON tag_bindings (user_id, ended_at) WHERE user_id IS NOT NULL;
CREATE INDEX tag_bindings_tag_last ON tag_bindings (tag_id, ended_at);
CREATE UNIQUE INDEX tag_bindings_idempotency ON tag_bindings (scanner_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE TABLE tag_enrollments (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT NOT NULL REFERENCES passes (id) ON DELETE CASCADE,
  scanner_id TEXT NOT NULL REFERENCES scanners (id) ON DELETE CASCADE,
  requested_by TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('pass', 'user')),
  -- The pass owner at request time, user scope only.
  user_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'done', 'cancelled', 'declined', 'expired', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at - created_at BETWEEN 1 AND 90000),
  -- The pass's credential generation and owner when asked: completion needs them unchanged.
  holder_generation INTEGER NOT NULL,
  holder_owner TEXT,
  -- The device fetched the request and shows it.
  shown_at INTEGER,
  ended_at INTEGER,
  binding_id TEXT REFERENCES tag_bindings (id) ON DELETE SET NULL,
  error_code TEXT,
  CHECK ((scope = 'user') = (user_id IS NOT NULL)),
  CHECK ((state = 'pending') = (ended_at IS NULL))
);
CREATE UNIQUE INDEX tag_enrollments_scanner ON tag_enrollments (scanner_id) WHERE state = 'pending';
CREATE UNIQUE INDEX tag_enrollments_pass ON tag_enrollments (pass_id) WHERE state = 'pending';
CREATE INDEX tag_enrollments_org ON tag_enrollments (org_id, mode, created_at);
CREATE INDEX tag_enrollments_ended ON tag_enrollments (ended_at) WHERE ended_at IS NOT NULL;
CREATE INDEX tag_enrollments_binding ON tag_enrollments (binding_id) WHERE binding_id IS NOT NULL;
INSERT INTO nfc_tags (id, org_id, mode, tag_ref, system, hint, label, status, status_at, created_at, last_seen_at, lost_at, lost_by)
  SELECT id, org_id, mode, tag_ref, kind, hint, label, status, status_at, created_at, last_seen_at, lost_at, lost_by
  FROM _keep_nfc_tags ORDER BY rowid;
INSERT INTO tag_bindings (id, tag_id, scope, pass_id, user_id, source, bound_at, bound_by_type, bound_by, scanner_id, holder_generation, holder_owner, ended_at, ended_by_type, ended_by, end_cause, idempotency_key, request_hash, cleared_lost_at, cleared_lost_by)
  SELECT id, tag_id, scope, pass_id, user_id, source, bound_at, bound_by_type, bound_by, scanner_id, holder_generation, holder_owner, ended_at, ended_by_type, ended_by, end_cause, idempotency_key, request_hash, cleared_lost_at, cleared_lost_by
  FROM _keep_tag_bindings ORDER BY rowid;
INSERT INTO tag_enrollments SELECT * FROM _keep_tag_enrollments ORDER BY rowid;
DROP TABLE _keep_tag_enrollments;
DROP TABLE _keep_tag_bindings;
DROP TABLE _keep_nfc_tags;

-- Triggers carried over word for word (0088, 0095, 0097).
CREATE TRIGGER tag_bindings_insert_check BEFORE INSERT ON tag_bindings
BEGIN
  SELECT RAISE(ABORT, 'tag_binding_ended') WHERE NEW.ended_at IS NOT NULL;
  SELECT RAISE(ABORT, 'tag_retired') WHERE EXISTS (SELECT 1 FROM nfc_tags t WHERE t.id = NEW.tag_id AND t.status <> 'active');
  SELECT RAISE(ABORT, 'tag_lost') WHERE EXISTS (SELECT 1 FROM nfc_tags t WHERE t.id = NEW.tag_id AND t.lost_at IS NOT NULL);
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
CREATE TRIGGER tag_bindings_update_check BEFORE UPDATE ON tag_bindings
BEGIN
  SELECT RAISE(ABORT, 'tag_binding_immutable') WHERE OLD.ended_at IS NOT NULL
    OR NEW.id IS NOT OLD.id OR NEW.tag_id IS NOT OLD.tag_id OR NEW.scope IS NOT OLD.scope
    OR NEW.user_id IS NOT OLD.user_id OR NEW.source IS NOT OLD.source OR NEW.bound_at IS NOT OLD.bound_at
    OR NEW.bound_by_type IS NOT OLD.bound_by_type OR NEW.bound_by IS NOT OLD.bound_by
    OR NEW.scanner_id IS NOT OLD.scanner_id
    OR NEW.holder_generation IS NOT OLD.holder_generation OR NEW.holder_owner IS NOT OLD.holder_owner
    OR (NEW.ended_at IS NOT NULL AND NEW.pass_id IS NOT OLD.pass_id);
  SELECT RAISE(ABORT, 'tag_binding_reanchor') WHERE NEW.pass_id IS NOT OLD.pass_id AND NOT EXISTS (
    SELECT 1 FROM passes p JOIN nfc_tags t ON t.id = NEW.tag_id
    WHERE p.id = NEW.pass_id AND NEW.scope = 'user' AND p.owner_user_id = NEW.user_id
      AND p.org_id = t.org_id AND p.mode = t.mode AND p.deleted_at IS NULL);
END;
CREATE TRIGGER nfc_tags_retire_ends AFTER UPDATE OF status ON nfc_tags WHEN NEW.status = 'retired'
BEGIN
  UPDATE tag_bindings SET ended_at = CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER), ended_by_type = 'system',
    ended_by = 'tags', end_cause = 'tag_retired'
  WHERE tag_id = NEW.id AND ended_at IS NULL;
END;
CREATE TRIGGER tag_enrollments_insert_check BEFORE INSERT ON tag_enrollments
BEGIN
  SELECT RAISE(ABORT, 'enrollment_pending') WHERE NEW.state <> 'pending';
  SELECT RAISE(ABORT, 'enrollment_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM passes p JOIN scanners s ON s.org_id = p.org_id AND s.mode = p.mode
    WHERE p.id = NEW.pass_id AND s.id = NEW.scanner_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode
      AND p.deleted_at IS NULL AND s.revoked_at IS NULL AND s.device_role = 'scan' AND s.kind = 'device');
  SELECT RAISE(ABORT, 'enrollment_owner') WHERE NEW.scope = 'user'
    AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = NEW.pass_id AND p.owner_user_id = NEW.user_id);
END;
CREATE TRIGGER tag_enrollments_update_check BEFORE UPDATE ON tag_enrollments
BEGIN
  -- A finished request keeps its row; only the binding it made may go (the foreign key sets it NULL).
  SELECT RAISE(ABORT, 'enrollment_immutable') WHERE (OLD.state <> 'pending'
      AND NOT (NEW.binding_id IS NULL AND OLD.binding_id IS NOT NULL AND NEW.state IS OLD.state
        AND NEW.ended_at IS OLD.ended_at AND NEW.error_code IS OLD.error_code AND NEW.shown_at IS OLD.shown_at))
    OR NEW.holder_generation IS NOT OLD.holder_generation OR NEW.holder_owner IS NOT OLD.holder_owner
    OR NEW.id IS NOT OLD.id OR NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode
    OR NEW.pass_id IS NOT OLD.pass_id OR NEW.scanner_id IS NOT OLD.scanner_id
    OR NEW.requested_by IS NOT OLD.requested_by OR NEW.scope IS NOT OLD.scope
    OR NEW.user_id IS NOT OLD.user_id OR NEW.created_at IS NOT OLD.created_at
    OR NEW.expires_at IS NOT OLD.expires_at
    OR (OLD.shown_at IS NOT NULL AND NEW.shown_at IS NOT OLD.shown_at);
END;
CREATE TRIGGER tag_bindings_lost_marks AFTER UPDATE OF end_cause ON tag_bindings
WHEN NEW.end_cause = 'lost'
BEGIN
  UPDATE nfc_tags SET lost_at = NEW.ended_at, lost_by = NEW.ended_by WHERE id = NEW.tag_id AND lost_at IS NULL;
END;
CREATE TRIGGER tag_bindings_lost_needs_actor BEFORE UPDATE OF end_cause ON tag_bindings
WHEN NEW.end_cause = 'lost' AND NEW.ended_by IS NULL
BEGIN SELECT RAISE(ABORT, 'tag_lost_needs_actor'); END;
-- nfc_tags_kind_insert (0088) is replaced by nfc_tags_system_insert below; nfc_tags_fixed now fixes `system`.
CREATE TRIGGER nfc_tags_fixed BEFORE UPDATE OF id, org_id, mode, tag_ref, system, hint, created_at ON nfc_tags
BEGIN SELECT RAISE(ABORT, 'tag_fixed_columns'); END;
-- rebuild:end

-- New: a tag's system is on, and its type (when set) is its org's, active and of its system.
CREATE TRIGGER nfc_tags_system_insert BEFORE INSERT ON nfc_tags
BEGIN
  SELECT RAISE(ABORT, 'tag_system_disabled') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_systems s WHERE s.id = NEW.system AND s.enabled = 1);
END;
CREATE TRIGGER nfc_tags_type_insert BEFORE INSERT ON nfc_tags WHEN NEW.type_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'tag_type_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'tag_type_system') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.system <> NEW.system);
  SELECT RAISE(ABORT, 'tag_type_archived') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.archived_at IS NOT NULL);
END;
CREATE TRIGGER nfc_tags_type_update BEFORE UPDATE OF type_id ON nfc_tags
WHEN NEW.type_id IS NOT NULL AND NEW.type_id IS NOT OLD.type_id
BEGIN
  SELECT RAISE(ABORT, 'tag_type_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'tag_type_system') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.system <> NEW.system);
  SELECT RAISE(ABORT, 'tag_type_archived') WHERE EXISTS (
    SELECT 1 FROM nfc_tag_types y WHERE y.id = NEW.type_id AND y.archived_at IS NOT NULL);
END;

-- New: a binding of a typed tag obeys the type's scopes, its per-pass limit and its templates. A tag with no
-- type (Standard) keeps the 0088 limits only. An archived type does not block a binding: its tags keep working.
CREATE TRIGGER tag_bindings_type_check BEFORE INSERT ON tag_bindings
WHEN EXISTS (SELECT 1 FROM nfc_tags t WHERE t.id = NEW.tag_id AND t.type_id IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'tag_type_scope') WHERE EXISTS (
    SELECT 1 FROM nfc_tags t JOIN nfc_tag_types y ON y.id = t.type_id
    WHERE t.id = NEW.tag_id AND y.scopes <> 'both' AND y.scopes <> NEW.scope);
  SELECT RAISE(ABORT, 'tag_type_limit') WHERE NEW.scope = 'pass'
    AND (SELECT count(*) FROM tag_bindings b JOIN nfc_tags bt ON bt.id = b.tag_id
      WHERE b.pass_id = NEW.pass_id AND b.scope = 'pass' AND b.ended_at IS NULL
        AND bt.type_id = (SELECT t.type_id FROM nfc_tags t WHERE t.id = NEW.tag_id))
    >= (SELECT y.per_pass FROM nfc_tags t JOIN nfc_tag_types y ON y.id = t.type_id WHERE t.id = NEW.tag_id);
  SELECT RAISE(ABORT, 'tag_type_template') WHERE EXISTS (
      SELECT 1 FROM nfc_tags t JOIN nfc_tag_type_templates tt ON tt.type_id = t.type_id WHERE t.id = NEW.tag_id)
    AND NOT EXISTS (
      SELECT 1 FROM nfc_tags t JOIN nfc_tag_type_templates tt ON tt.type_id = t.type_id
      JOIN passes p ON p.template_id = tt.template_id
      WHERE t.id = NEW.tag_id AND p.id = NEW.pass_id);
END;
-- The expiry is set when the binding is made and never moves.
CREATE TRIGGER tag_bindings_expiry_fixed BEFORE UPDATE OF expires_at ON tag_bindings
WHEN NEW.expires_at IS NOT OLD.expires_at
BEGIN SELECT RAISE(ABORT, 'tag_binding_immutable'); END;
CREATE INDEX tag_bindings_expiry ON tag_bindings (expires_at) WHERE ended_at IS NULL AND expires_at IS NOT NULL;

-- New: type rows. Org, system and creation never change; every update raises `version` by one.
CREATE TRIGGER nfc_tag_types_insert BEFORE INSERT ON nfc_tag_types
BEGIN
  SELECT RAISE(ABORT, 'tag_system_disabled') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_systems s WHERE s.id = NEW.system AND s.enabled = 1);
END;
CREATE TRIGGER nfc_tag_types_fixed BEFORE UPDATE OF id, org_id, system, created_at, created_by ON nfc_tag_types
BEGIN SELECT RAISE(ABORT, 'tag_type_fixed'); END;
CREATE TRIGGER nfc_tag_types_version BEFORE UPDATE ON nfc_tag_types
WHEN NEW.version IS NOT OLD.version + 1
BEGIN SELECT RAISE(ABORT, 'tag_type_version'); END;
CREATE TRIGGER nfc_tag_type_templates_tenant BEFORE INSERT ON nfc_tag_type_templates
BEGIN
  SELECT RAISE(ABORT, 'tag_type_tenant') WHERE NOT EXISTS (
    SELECT 1 FROM nfc_tag_types y JOIN templates tpl ON tpl.org_id = y.org_id
    WHERE y.id = NEW.type_id AND tpl.id = NEW.template_id);
END;
