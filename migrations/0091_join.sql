-- Join links: a public link and QR that makes a pass with no operator. One link per (org, mode, template).
-- `token` holds the MAC of the link token (platform/capability-token.ts, purpose `join`); the sealed copy
-- lets an admin copy the link again. Mode is the link's, fixed at creation.
CREATE TABLE join_links (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  template_id TEXT NOT NULL REFERENCES templates (id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (token GLOB 'h1:*'),
  generation INTEGER NOT NULL DEFAULT 1 CHECK (generation >= 1),
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  name_input TEXT,
  ask_email INTEGER NOT NULL DEFAULT 0 CHECK (ask_email IN (0, 1)),
  -- 50 fits both modes; the service always writes the limit it means (200 for a live link by default).
  daily_limit INTEGER NOT NULL DEFAULT 50
    CHECK (daily_limit BETWEEN 1 AND 5000 AND (mode = 'live' OR daily_limit <= 50)),
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  rotated_at INTEGER,
  created_by TEXT,
  updated_by TEXT,
  UNIQUE (org_id, mode, template_id)
);

CREATE INDEX join_links_template ON join_links (template_id);

-- The shape of pass_token_seals: org-bearing, written through the grant that rotates the token.
CREATE TABLE join_link_seals (
  link_id TEXT PRIMARY KEY REFERENCES join_links (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  kek_version INTEGER NOT NULL,
  iv BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,
  ciphertext BLOB NOT NULL
);

-- One row per card a link made: the cap counts, and the device and network digests of the replay and
-- device limits. The three keys are nulled after 48 hours; the row goes with its pass.
CREATE TABLE join_issues (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES join_links (id) ON DELETE CASCADE,
  org_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('live', 'test')),
  pass_id TEXT NOT NULL UNIQUE REFERENCES passes (id) ON DELETE CASCADE,
  link_generation INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  ip_key TEXT,
  device_key TEXT,
  fields_hash TEXT
);
CREATE INDEX join_issues_link_at ON join_issues (link_id, created_at);
CREATE INDEX join_issues_org_at ON join_issues (org_id, mode, created_at);
CREATE INDEX join_issues_device ON join_issues (device_key, link_id, created_at) WHERE device_key IS NOT NULL;
CREATE INDEX join_issues_keys_due ON join_issues (created_at) WHERE ip_key IS NOT NULL OR device_key IS NOT NULL;
-- The duplicate check of a join submit: an active card on this template with this address.
CREATE INDEX passes_template_email ON passes (template_id, mode, holder_email) WHERE holder_email IS NOT NULL;

CREATE TRIGGER join_links_scope_immutable BEFORE UPDATE OF org_id, mode, template_id ON join_links
WHEN NEW.org_id IS NOT OLD.org_id OR NEW.mode IS NOT OLD.mode OR NEW.template_id IS NOT OLD.template_id
BEGIN SELECT RAISE(ABORT, 'a join link keeps its org, mode and template'); END;

-- The generation is the link's epoch: a new token moves it up (the trigger below when the writer did not),
-- and it never goes down. An in-flight submit at the old generation then fails its actor check.
CREATE TRIGGER join_links_generation_up BEFORE UPDATE OF generation ON join_links
WHEN NEW.generation < OLD.generation
BEGIN SELECT RAISE(ABORT, 'a join link generation never goes down'); END;
CREATE TRIGGER join_links_token_bumps_generation AFTER UPDATE OF token ON join_links
WHEN NEW.token IS NOT OLD.token AND NEW.generation = OLD.generation
BEGIN UPDATE join_links SET generation = OLD.generation + 1 WHERE id = NEW.id; END;

-- A card is made by a link of its own org and mode, for a pass of that org, mode and template, at the link's generation.
CREATE TRIGGER join_issues_scope BEFORE INSERT ON join_issues
WHEN NOT EXISTS (SELECT 1 FROM join_links l WHERE l.id = NEW.link_id AND l.org_id = NEW.org_id
    AND l.mode = NEW.mode AND l.generation = NEW.link_generation)
  OR NOT EXISTS (SELECT 1 FROM passes p JOIN join_links l ON l.id = NEW.link_id
    WHERE p.id = NEW.pass_id AND p.org_id = NEW.org_id AND p.mode = NEW.mode AND p.template_id = l.template_id)
BEGIN SELECT RAISE(ABORT, 'a join issue matches its link and pass in org, mode and generation'); END;

-- The ledger is append-only: only the three keys are ever cleared.
CREATE TRIGGER join_issues_immutable BEFORE UPDATE ON join_issues
WHEN NEW.id IS NOT OLD.id OR NEW.link_id IS NOT OLD.link_id OR NEW.org_id IS NOT OLD.org_id
  OR NEW.mode IS NOT OLD.mode OR NEW.pass_id IS NOT OLD.pass_id
  OR NEW.link_generation IS NOT OLD.link_generation OR NEW.created_at IS NOT OLD.created_at
  OR (NEW.ip_key IS NOT NULL AND NEW.ip_key IS NOT OLD.ip_key)
  OR (NEW.device_key IS NOT NULL AND NEW.device_key IS NOT OLD.device_key)
  OR (NEW.fields_hash IS NOT NULL AND NEW.fields_hash IS NOT OLD.fields_hash)
BEGIN SELECT RAISE(ABORT, 'join issues change only by clearing their keys'); END;

-- A row leaves only with its pass or its link (the foreign key cascades run once the parent is gone), so no
-- grant can delete one to free a cap slot or the device limit.
CREATE TRIGGER join_issues_no_delete BEFORE DELETE ON join_issues
WHEN EXISTS (SELECT 1 FROM passes p WHERE p.id = OLD.pass_id) AND EXISTS (SELECT 1 FROM join_links l WHERE l.id = OLD.link_id)
BEGIN SELECT RAISE(ABORT, 'a join issue goes with its pass or link'); END;
