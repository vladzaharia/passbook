-- Org lifecycle (MT11). A closed org is `status = 'deleted'` with `closed_at` and `purge_after`
-- (closed_at + 30 days). `purge_started_at` marks the purge workflow: only an org that is closed, in purge
-- and under no active hold lets the triggers below delete its history.
ALTER TABLE orgs ADD COLUMN closed_at INTEGER CHECK (closed_at IS NULL OR closed_at > 0);
ALTER TABLE orgs ADD COLUMN purge_after INTEGER CHECK (purge_after IS NULL OR purge_after > 0);
ALTER TABLE orgs ADD COLUMN purge_started_at INTEGER CHECK (purge_started_at IS NULL OR purge_started_at > 0);
ALTER TABLE orgs ADD COLUMN purged_at INTEGER CHECK (purged_at IS NULL OR purged_at > 0);
-- The default signing identity at close (closing clears the live one), so a reopen can restore it.
ALTER TABLE orgs ADD COLUMN closed_identity_id TEXT;

-- Orgs deleted before this migration have no purge_after, so no purge ever starts for them.

CREATE TABLE org_exports (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES orgs (id),
  requested_by TEXT REFERENCES users (id) ON DELETE SET NULL,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'running', 'ready', 'failed', 'expired')),
  r2_key TEXT,
  bytes INTEGER,
  entities TEXT CHECK (entities IS NULL OR json_valid(entities)),
  error_code TEXT,
  created_at INTEGER NOT NULL,
  finished_at INTEGER,
  expires_at INTEGER
);
CREATE INDEX org_exports_org ON org_exports (org_id, created_at DESC);
CREATE INDEX org_exports_requested_by ON org_exports (requested_by);
CREATE INDEX org_exports_expiry ON org_exports (expires_at) WHERE state = 'ready';

-- Purge starts only for a closed org with no active hold; the check is atomic with the write.
CREATE TRIGGER orgs_purge_needs_closed BEFORE UPDATE OF purge_started_at ON orgs
WHEN NEW.purge_started_at IS NOT NULL AND OLD.purge_started_at IS NULL
  AND (NEW.status != 'deleted' OR NEW.purge_after IS NULL
    OR EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = OLD.id AND h.released_at IS NULL))
BEGIN
  SELECT RAISE(ABORT, 'org cannot be purged');
END;
-- A purging org stays closed.
CREATE TRIGGER orgs_purge_stays_closed BEFORE UPDATE OF status ON orgs
WHEN OLD.purge_started_at IS NOT NULL AND NEW.status != 'deleted'
BEGIN
  SELECT RAISE(ABORT, 'org is being purged');
END;

-- The history tables below refuse deletes. They allow one for an org in purge: closed, started and not held.
DROP TRIGGER org_memberships_no_delete;
CREATE TRIGGER org_memberships_no_delete BEFORE DELETE ON org_memberships
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable membership'); END;

DROP TRIGGER org_invitations_no_delete;
CREATE TRIGGER org_invitations_no_delete BEFORE DELETE ON org_invitations
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable invitation'); END;

DROP TRIGGER template_candidates_no_delete;
CREATE TRIGGER template_candidates_no_delete BEFORE DELETE ON template_candidates
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'template candidates are immutable'); END;

DROP TRIGGER template_approvals_no_delete;
CREATE TRIGGER template_approvals_no_delete BEFORE DELETE ON template_approvals
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM template_candidates p WHERE p.id = OLD.candidate_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'template approvals are immutable'); END;

DROP TRIGGER template_releases_no_delete;
CREATE TRIGGER template_releases_no_delete BEFORE DELETE ON template_releases
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'template releases are immutable'); END;

DROP TRIGGER template_version_extras_no_delete;
CREATE TRIGGER template_version_extras_no_delete BEFORE DELETE ON template_version_extras
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM templates p WHERE p.id = OLD.template_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'template version extras are immutable'); END;

DROP TRIGGER template_version_extra_sets_no_delete;
CREATE TRIGGER template_version_extra_sets_no_delete BEFORE DELETE ON template_version_extra_sets
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM templates p WHERE p.id = OLD.template_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'template version extra sets are immutable'); END;

DROP TRIGGER wallet_provider_credentials_no_delete;
CREATE TRIGGER wallet_provider_credentials_no_delete BEFORE DELETE ON wallet_provider_credentials
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider credential'); END;

DROP TRIGGER wallet_provider_account_events_no_delete;
CREATE TRIGGER wallet_provider_account_events_no_delete BEFORE DELETE ON wallet_provider_account_events
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider event'); END;

DROP TRIGGER wallet_samsung_tombstones_no_delete;
CREATE TRIGGER wallet_samsung_tombstones_no_delete BEFORE DELETE ON wallet_samsung_tombstones
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable Samsung tombstone'); END;

DROP TRIGGER wallet_provider_projection_evidence_history_no_delete;
CREATE TRIGGER wallet_provider_projection_evidence_history_no_delete BEFORE DELETE ON wallet_provider_projection_evidence_history
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable Samsung provider evidence'); END;

DROP TRIGGER pass_credential_transfer_payload_no_delete;
CREATE TRIGGER pass_credential_transfer_payload_no_delete BEFORE DELETE ON pass_credential_transfer_payloads
WHEN (EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.id = OLD.transfer_id AND t.state = 'pending')) AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM pass_credential_transfers p WHERE p.id = OLD.transfer_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'credential transfer payload is immutable'); END;

DROP TRIGGER pass_credential_transfer_pending_no_pass_delete;
CREATE TRIGGER pass_credential_transfer_pending_no_pass_delete BEFORE DELETE ON passes
WHEN (EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = OLD.id AND t.state = 'pending')) AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'pending credential transfer cannot be deleted'); END;

DROP TRIGGER connection_webhook_unresolved_item_no_delete;
CREATE TRIGGER connection_webhook_unresolved_item_no_delete BEFORE DELETE ON connection_webhook_items
WHEN (OLD.state IN ('started', 'uncertain')) AND NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM connection_webhook_retention p WHERE p.id = OLD.retention_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'unresolved retained webhook claim'); END;

DROP TRIGGER template_version_hashes_no_delete;
CREATE TRIGGER template_version_hashes_no_delete BEFORE DELETE ON template_version_hashes
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM templates p WHERE p.id = OLD.template_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'template version hashes are immutable'); END;

DROP TRIGGER wallet_provider_accounts_no_delete;
CREATE TRIGGER wallet_provider_accounts_no_delete BEFORE DELETE ON wallet_provider_accounts
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet provider account'); END;

DROP TRIGGER wallet_credential_versions_no_delete;
CREATE TRIGGER wallet_credential_versions_no_delete BEFORE DELETE ON wallet_credential_versions
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM wallet_credentials p WHERE p.id = OLD.credential_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential version'); END;

DROP TRIGGER wallet_credential_events_no_delete;
CREATE TRIGGER wallet_credential_events_no_delete BEFORE DELETE ON wallet_credential_events
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM wallet_credentials p WHERE p.id = OLD.credential_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential event'); END;

DROP TRIGGER wallet_credential_checks_no_delete;
CREATE TRIGGER wallet_credential_checks_no_delete BEFORE DELETE ON wallet_credential_checks
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = (SELECT p.org_id FROM wallet_credentials p WHERE p.id = OLD.credential_id) AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential check'); END;

DROP TRIGGER wallet_enrolment_events_no_delete;
CREATE TRIGGER wallet_enrolment_events_no_delete BEFORE DELETE ON wallet_enrolment_events
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet enrolment event'); END;

DROP TRIGGER wallet_credentials_no_delete;
CREATE TRIGGER wallet_credentials_no_delete BEFORE DELETE ON wallet_credentials
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = OLD.org_id AND o.status = 'deleted' AND o.purge_started_at IS NOT NULL AND NOT EXISTS (SELECT 1 FROM retention_holds h WHERE h.org_id = o.id AND h.released_at IS NULL))
BEGIN SELECT RAISE(ABORT, 'immutable wallet credential'); END;
