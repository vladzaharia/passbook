-- The ledger of Google change messages (google-messages.md section 5, without the text: the history is read from
-- the object when it is trimmed). One row per (instance, base version, target version): a retry of an operation, or
-- a re-queue of the same pass version, finds its row and sends nothing again. `sending` is written immediately
-- before the POST, so a crash between the POST and the settle is seen next run and checked with a read.
CREATE TABLE wallet_google_messages (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL REFERENCES wallet_provider_instances(id) ON DELETE CASCADE,
  base_version INTEGER NOT NULL CHECK (base_version > 0),
  target_version INTEGER NOT NULL CHECK (target_version > base_version),
  notify INTEGER NOT NULL CHECK (notify IN (0, 1)),
  state TEXT NOT NULL CHECK (state IN ('sending', 'notified', 'text', 'failed', 'unknown')),
  reason TEXT CHECK (reason IS NULL OR reason IN ('budget', 'quota', 'refused', 'unconfirmed')),
  http_status INTEGER CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  created_at INTEGER NOT NULL,
  settled_at INTEGER,
  UNIQUE (instance_id, base_version, target_version),
  CHECK ((state = 'sending') = (settled_at IS NULL))
);
CREATE UNIQUE INDEX wallet_google_messages_one_open ON wallet_google_messages (instance_id) WHERE state = 'sending';
CREATE INDEX wallet_google_messages_window ON wallet_google_messages (instance_id, settled_at);
CREATE TRIGGER wallet_google_messages_immutable
BEFORE UPDATE OF id, instance_id, base_version, target_version, notify, created_at ON wallet_google_messages
BEGIN SELECT RAISE(ABORT, 'google message identity is immutable'); END;
CREATE TRIGGER wallet_google_messages_settled_final
BEFORE UPDATE ON wallet_google_messages WHEN OLD.state != 'sending'
BEGIN SELECT RAISE(ABORT, 'a settled google message is final'); END;

-- CW11: Samsung schema 1 (field mappings and their stored evidence) is retired beside schema 2. A provider
-- release is a compiled candidate only, and a Samsung release needs the card-state row of 0199 (now also by its
-- state, not only its testing mode). The evidence tables stay as history; nothing writes them any more.
-- Tombstones and retirement keep 0199's definitions: their schema 1 branches only match rows that cannot be
-- created now.
DROP TRIGGER template_provider_releases_insert;
CREATE TRIGGER template_provider_releases_insert BEFORE INSERT ON template_releases
WHEN NEW.provider IN ('google', 'samsung')
BEGIN
  SELECT CASE WHEN NEW.source != 'approved' OR NEW.org_id IS NULL
    OR NEW.generation != COALESCE((SELECT MAX(r.generation) FROM template_releases r
      WHERE r.template_id = NEW.template_id AND r.org_id = NEW.org_id
        AND r.mode = NEW.mode AND r.provider = NEW.provider), 0) + 1
    OR NEW.previous_release_id IS NOT (SELECT r.id FROM template_releases r
      WHERE r.template_id = NEW.template_id AND r.org_id = NEW.org_id
        AND r.mode = NEW.mode AND r.provider = NEW.provider ORDER BY r.generation DESC LIMIT 1)
    THEN RAISE(ABORT, 'stale provider release') END;
  -- Validate the same immutable candidate in bounded predicates: combining the expanded
  -- Apple source view and nested provider evidence exceeds D1's expression-depth limit.
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM template_candidates c JOIN template_approvals a ON a.candidate_id = c.id
    JOIN template_versions v ON v.template_id = c.template_id AND v.version = c.version
    JOIN wallet_provider_accounts account ON account.id = c.provider_account_id
      AND account.org_id = c.org_id AND account.mode = c.mode AND account.provider = c.provider
      AND account.authority_epoch = c.provider_account_epoch
      AND account.credential_id IS NOT NULL
      AND account.revoked_at IS NULL
    WHERE c.id = NEW.candidate_id AND a.id = NEW.approval_id AND c.template_id = NEW.template_id
      AND c.org_id = NEW.org_id AND c.mode = NEW.mode AND c.provider = NEW.provider AND c.version = NEW.version
      AND c.candidate_hash = NEW.candidate_hash AND a.candidate_hash = c.candidate_hash
      AND c.content_hash = NEW.content_hash AND c.adapter_revision = NEW.adapter_revision
      AND c.adapter_capabilities = NEW.adapter_capabilities AND c.audience_policy_revision = NEW.audience_policy_revision
      AND a.reviewer_id != c.author_id
      AND (c.version_author_id IS NULL OR (c.author_id = 'system:wallet-projection' AND c.provider = 'google') OR a.reviewer_id != c.version_author_id)
      AND (a.reviewer_id != 'system:wallet-projection:auto' OR (c.author_id = 'system:wallet-projection' AND NEW.created_by = 'system:wallet-projection:auto'
        AND json_array_length(json_extract(c.projection_json, '$.approvedOmissions')) = 0))
      AND NEW.created_by IS NOT NULL
      AND v.created_by IS c.version_author_id AND c.projection_json IS NOT NULL
      AND json_extract(c.projection_json, '$.schema') = 2
      AND c.adapter_revision = 1 AND c.audience_policy_revision = 1
      AND ((c.provider = 'google' AND c.adapter_capabilities = '["generic-text","qr-code","reviewed-artwork"]')
        OR (c.provider = 'samsung' AND c.adapter_capabilities = '["loyalty-text","qr-code","reviewed-artwork"]'))
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM template_candidates c
    JOIN template_provider_apple_sources s ON s.id = c.source_release_id
    WHERE c.id = NEW.candidate_id
      AND s.template_id = c.template_id AND s.mode = c.mode AND s.version = c.version
      AND (s.org_id = c.org_id OR (s.org_id IS NULL AND s.origin = 'baked' AND s.template_org_id IS NULL))
      AND s.generation = c.source_release_generation AND s.candidate_hash = c.source_release_hash
      AND s.content_hash = c.content_hash
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  -- Operator review is not provider proof. A Samsung release needs a fresh card-state row from a live read;
  -- Google has no documented status proof, so its release rests on the compiled pins checked above.
  SELECT CASE WHEN NEW.provider = 'samsung' AND NOT EXISTS (
    SELECT 1 FROM template_candidates c JOIN wallet_samsung_card_state st ON st.candidate_id = c.id
    WHERE c.id = NEW.candidate_id AND st.candidate_hash = c.candidate_hash
      AND st.account_id = c.provider_account_id AND st.account_epoch = c.provider_account_epoch
      AND st.card_type = json_extract(c.projection_json, '$.type')
      AND ((st.state = 'ACTIVE' AND st.testing_mode_off = 'Y') OR (NEW.mode = 'test' AND st.state != 'BLOCKED'))
      AND st.verified_at <= NEW.created_at AND NEW.created_at < st.expires_at
  ) THEN RAISE(ABORT, 'invalid provider release approval or source') END;
  SELECT CASE WHEN NEW.action = 'release' AND EXISTS (
    SELECT 1 FROM template_releases r WHERE r.candidate_id = NEW.candidate_id AND r.source = 'approved'
  ) THEN RAISE(ABORT, 'provider candidate already released') END;
  SELECT CASE WHEN NEW.action = 'rollback' AND NOT EXISTS (
    SELECT 1 FROM template_releases r WHERE r.id = NEW.rollback_of_release_id AND r.source = 'approved'
      AND r.template_id = NEW.template_id AND r.org_id = NEW.org_id AND r.mode = NEW.mode
      AND r.provider = NEW.provider AND r.generation < NEW.generation - 1
      AND r.candidate_id = NEW.candidate_id AND r.approval_id = NEW.approval_id
      AND r.candidate_hash = NEW.candidate_hash AND r.version = NEW.version
  ) THEN RAISE(ABORT, 'invalid provider rollback') END;
  SELECT CASE WHEN NEW.adapter_revision < COALESCE((
    SELECT r.adapter_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) OR NEW.audience_policy_revision < COALESCE((
    SELECT r.audience_policy_revision FROM template_releases r WHERE r.template_id = NEW.template_id
      AND r.org_id = NEW.org_id AND r.mode = NEW.mode AND r.provider = NEW.provider
    ORDER BY r.generation DESC LIMIT 1), 0) THEN RAISE(ABORT, 'stale provider policy') END;
END;
