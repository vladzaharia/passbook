-- Developer sandbox (PX7). A developer org is a person's own test bench: it never holds Live and never issues
-- a real wallet pass. `kind` is set when the org is made and never changes; the principal SQL refuses Live for
-- it (authority-principal.ts), and the triggers below refuse a Live key or pass as a second line.
ALTER TABLE orgs ADD COLUMN kind TEXT NOT NULL DEFAULT 'standard' CHECK (kind IN ('standard', 'developer'));

CREATE TRIGGER orgs_kind_immutable BEFORE UPDATE OF kind ON orgs
WHEN NEW.kind IS NOT OLD.kind
BEGIN SELECT RAISE(ABORT, 'org kind is immutable'); END;

CREATE TRIGGER api_keys_developer_test_only BEFORE INSERT ON api_keys
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live key'); END;

CREATE TRIGGER passes_developer_test_only BEFORE INSERT ON passes
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live pass'); END;

CREATE TRIGGER scanners_developer_test_only_insert BEFORE INSERT ON scanners
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live scanner'); END;
CREATE TRIGGER scanners_developer_test_only_update BEFORE UPDATE OF mode ON scanners
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live scanner'); END;
CREATE TRIGGER join_links_developer_test_only BEFORE INSERT ON join_links
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live join link'); END;

-- Every other table that holds an org's data per mode: no row of a developer org is Live, whoever writes it.
CREATE TRIGGER pass_events_developer_no_live BEFORE INSERT ON pass_events
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER bundles_developer_no_live BEFORE INSERT ON bundles
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER broadcasts_developer_no_live BEFORE INSERT ON broadcasts
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_events_developer_no_live BEFORE INSERT ON scan_events
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scans_developer_no_live BEFORE INSERT ON scans
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_gates_developer_no_live BEFORE INSERT ON scan_gates
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_presence_developer_no_live BEFORE INSERT ON scan_presence
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scanner_setups_developer_no_live BEFORE INSERT ON scanner_setups
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scanning_sessions_developer_no_live BEFORE INSERT ON scanning_sessions
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scanning_devices_developer_no_live BEFORE INSERT ON scanning_devices
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER template_candidates_developer_no_live BEFORE INSERT ON template_candidates
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER template_releases_developer_no_live BEFORE INSERT ON template_releases
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER template_release_reissues_developer_no_live BEFORE INSERT ON template_release_reissues
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER workflow_release_snapshots_developer_no_live BEFORE INSERT ON workflow_release_snapshots
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_provider_credentials_developer_no_live BEFORE INSERT ON wallet_provider_credentials
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_provider_account_events_developer_no_live BEFORE INSERT ON wallet_provider_account_events
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_samsung_tombstones_developer_no_live BEFORE INSERT ON wallet_samsung_tombstones
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_provider_projection_evidence_developer_no_live BEFORE INSERT ON wallet_provider_projection_evidence
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_provider_projection_evidence_history_developer_no_live BEFORE INSERT ON wallet_provider_projection_evidence_history
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_retention_proofs_developer_no_live BEFORE INSERT ON scan_retention_proofs
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_retention_event_transitions_developer_no_live BEFORE INSERT ON scan_retention_event_transitions
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_retention_delete_intents_developer_no_live BEFORE INSERT ON scan_retention_delete_intents
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_retained_gates_developer_no_live BEFORE INSERT ON scan_retained_gates
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_credential_transfers_developer_no_live BEFORE INSERT ON pass_credential_transfers
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_credential_tombstones_developer_no_live BEFORE INSERT ON pass_credential_tombstones
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_holder_reissue_required_developer_no_live BEFORE INSERT ON pass_holder_reissue_required
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_issuance_deliveries_developer_no_live BEFORE INSERT ON pass_issuance_deliveries
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_place_revs_developer_no_live BEFORE INSERT ON scan_place_revs
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_imports_developer_no_live BEFORE INSERT ON pass_imports
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER webhook_endpoints_developer_no_live BEFORE INSERT ON webhook_endpoints
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER webhook_endpoint_secrets_developer_no_live BEFORE INSERT ON webhook_endpoint_secrets
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER event_feed_developer_no_live BEFORE INSERT ON event_feed
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER webhook_deliveries_developer_no_live BEFORE INSERT ON webhook_deliveries
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER webhook_attempts_developer_no_live BEFORE INSERT ON webhook_attempts
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER join_issues_developer_no_live BEFORE INSERT ON join_issues
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_code_rotations_developer_no_live BEFORE INSERT ON scan_code_rotations
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER message_rules_developer_no_live BEFORE INSERT ON message_rules
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER message_rule_fires_developer_no_live BEFORE INSERT ON message_rule_fires
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER join_marks_developer_no_live BEFORE INSERT ON join_marks
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER template_channel_policies_developer_no_live BEFORE INSERT ON template_channel_policies
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_channels_developer_no_live BEFORE INSERT ON pass_channels
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_channel_copies_developer_no_live BEFORE INSERT ON pass_channel_copies
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER authority_grants_developer_no_live BEFORE INSERT ON authority_grants
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_prints_developer_no_live BEFORE INSERT ON pass_prints
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_provider_accounts_developer_no_live BEFORE INSERT ON wallet_provider_accounts
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_credentials_developer_no_live BEFORE INSERT ON wallet_credentials
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_enrolment_events_developer_no_live BEFORE INSERT ON wallet_enrolment_events
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_provider_instances_developer_no_live BEFORE INSERT ON wallet_provider_instances
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_samsung_callback_receipts_developer_no_live BEFORE INSERT ON wallet_samsung_callback_receipts
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER wallet_google_callback_receipts_developer_no_live BEFORE INSERT ON wallet_google_callback_receipts
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER channel_apply_runs_developer_no_live BEFORE INSERT ON channel_apply_runs
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_offline_reads_developer_no_live BEFORE INSERT ON scan_offline_reads
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER scan_session_changes_developer_no_live BEFORE INSERT ON scan_session_changes
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER visitors_developer_no_live BEFORE INSERT ON visitors
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER roll_calls_developer_no_live BEFORE INSERT ON roll_calls
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER roll_call_marks_developer_no_live BEFORE INSERT ON roll_call_marks
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER nfc_tags_developer_no_live BEFORE INSERT ON nfc_tags
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER tag_enrollments_developer_no_live BEFORE INSERT ON tag_enrollments
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER nfc_tag_keysets_developer_no_live BEFORE INSERT ON nfc_tag_keysets
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER idempotent_requests_developer_no_live BEFORE INSERT ON idempotent_requests
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;
CREATE TRIGGER pass_notes_developer_no_live BEFORE INSERT ON pass_notes
WHEN NEW.mode = 'live' AND EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer org holds no Live data'); END;

-- One sandbox per person. The funnel columns are set once (first call, first pass, first preview, first Live key
-- in any org); `closed_at` is set when the sandbox closes, idle or by an admin, and the row stays so a person
-- cannot make a second one.
CREATE TABLE developer_sandboxes (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL UNIQUE REFERENCES orgs (id),
  user_id TEXT NOT NULL UNIQUE REFERENCES users (id),
  created_at INTEGER NOT NULL,
  quickstart_viewed_at INTEGER,
  first_call_at INTEGER,
  first_pass_at INTEGER,
  first_preview_at INTEGER,
  first_live_key_at INTEGER,
  closed_at INTEGER,
  close_reason TEXT CHECK (close_reason IS NULL OR close_reason IN ('idle', 'admin', 'user')),
  CHECK ((closed_at IS NULL) = (close_reason IS NULL))
);
CREATE INDEX developer_sandboxes_open ON developer_sandboxes (created_at) WHERE closed_at IS NULL;

CREATE TRIGGER developer_sandboxes_fixed BEFORE UPDATE OF id, org_id, user_id, created_at ON developer_sandboxes
BEGIN SELECT RAISE(ABORT, 'a developer sandbox keeps its org and person'); END;
CREATE TRIGGER developer_sandboxes_funnel_set_once
BEFORE UPDATE OF quickstart_viewed_at, first_call_at, first_pass_at, first_preview_at, first_live_key_at, closed_at, close_reason
ON developer_sandboxes
WHEN (OLD.quickstart_viewed_at IS NOT NULL AND NEW.quickstart_viewed_at IS NOT OLD.quickstart_viewed_at)
  OR (OLD.first_call_at IS NOT NULL AND NEW.first_call_at IS NOT OLD.first_call_at)
  OR (OLD.first_pass_at IS NOT NULL AND NEW.first_pass_at IS NOT OLD.first_pass_at)
  OR (OLD.first_preview_at IS NOT NULL AND NEW.first_preview_at IS NOT OLD.first_preview_at)
  OR (OLD.first_live_key_at IS NOT NULL AND NEW.first_live_key_at IS NOT OLD.first_live_key_at)
  OR (OLD.closed_at IS NOT NULL AND (NEW.closed_at IS NOT OLD.closed_at OR NEW.close_reason IS NOT OLD.close_reason))
BEGIN SELECT RAISE(ABORT, 'a funnel column is set once'); END;
CREATE TRIGGER developer_sandboxes_no_delete BEFORE DELETE ON developer_sandboxes
BEGIN SELECT RAISE(ABORT, 'a developer sandbox is kept'); END;
CREATE TRIGGER developer_sandboxes_org_is_developer BEFORE INSERT ON developer_sandboxes
WHEN NOT EXISTS (SELECT 1 FROM orgs o WHERE o.id = NEW.org_id AND o.kind = 'developer')
BEGIN SELECT RAISE(ABORT, 'a developer sandbox belongs to a developer org'); END;

-- The developer preset belongs to developer orgs, and they take no other.
INSERT INTO entitlement_preset_meta (preset, label, is_plan, revision, updated_at) VALUES
  ('developer', 'Developer sandbox', 0, 1, 1795046400000);

INSERT INTO entitlement_presets (preset, key, value) VALUES
  ('developer', 'api', '"full"'),
  ('developer', 'api.rateTier', '"standard"'),
  ('developer', 'api.keys', '3'),
  ('developer', 'apps', '0'),
  ('developer', 'webhooks', '1'),
  ('developer', 'webhooks.endpoints', '3'),
  ('developer', 'connections', '0'),
  ('developer', 'connectors', '[]'),
  ('developer', 'wallet.google', '0'),
  ('developer', 'wallet.samsung', '0'),
  ('developer', 'print', '0'),
  ('developer', 'nfc', '"off"'),
  ('developer', 'scanning.devices', '0'),
  ('developer', 'join.perDay', '0'),
  ('developer', 'messages.perDay', '0'),
  ('developer', 'passes.live', '0'),
  ('developer', 'passes.test', '500'),
  ('developer', 'templates', '10'),
  ('developer', 'templates.uploads', '0'),
  ('developer', 'templates.stylesBlocked', '[]'),
  ('developer', 'email.perDay', '100'),
  ('developer', 'members', '1'),
  ('developer', 'brand.mark', '"full"'),
  ('developer', 'domains', '0'),
  ('developer', 'identity.own', '0');

CREATE TRIGGER org_entitlements_developer_preset_insert BEFORE INSERT ON org_entitlements
WHEN (NEW.preset = 'developer') != COALESCE((SELECT o.kind = 'developer' FROM orgs o WHERE o.id = NEW.org_id), 0)
BEGIN SELECT RAISE(ABORT, 'the developer preset is for developer orgs only'); END;
CREATE TRIGGER org_entitlements_developer_preset_update BEFORE UPDATE OF preset ON org_entitlements
WHEN (NEW.preset = 'developer') != COALESCE((SELECT o.kind = 'developer' FROM orgs o WHERE o.id = NEW.org_id), 0)
BEGIN SELECT RAISE(ABORT, 'the developer preset is for developer orgs only'); END;
