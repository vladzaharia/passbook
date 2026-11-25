// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SQL and source text matched as strings
// Lines the SQL lint (tools/check-sql-owner.ts) reviewed, pinned by their normalized text.
export const OPTIONAL_BIND_ALLOWED: Record<string, { text: string; reason: string }[]> = {
  'src/worker/modules/auth/repo.ts': [
    {
      text: 'WHERE ? = 0 OR NOT EXISTS (SELECT 1 FROM auth_identities WHERE user_id = ?)`,',
      reason: 'a flag picks whether an INSERT ... SELECT runs; bound values only, no tenant term',
    },
    {
      text: "AND (? = 'oidc' OR NOT EXISTS (SELECT 1 FROM org_memberships m WHERE m.user_id = users.id AND m.revoked_at IS NULL))`,",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
  ],
  'src/worker/modules/broadcasts/repo.ts': [
    {
      text: 'started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at),',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: 'error_code = COALESCE(?, error_code)',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/delivery/repo-binding.ts': [
    {
      text: "AND ((state = 'processing' AND (? = 0 OR available_at < ?))",
      reason:
        'a flag adds a time window; an outbox repair across the platform, no org filter by design',
    },
  ],
  'src/worker/modules/developer/repo-request-log.ts': [
    {
      text: "CASE WHEN ?5 = 'test' AND (?15 IS NOT NULL OR ?16 IS NOT NULL) THEN 1 ELSE 0 END,",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "CASE WHEN ?5 = 'test' THEN ?15 END,",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "CASE WHEN ?5 = 'test' THEN ?16 END, ?17",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/identities/repo-runs.ts': [
    {
      text: 'csr_pubkey_sha256 = COALESCE(?, csr_pubkey_sha256)',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/message-rules/repo.ts': [
    {
      text: '`UPDATE message_rules SET next_check_at = ?, last_broadcast_id = COALESCE(?, last_broadcast_id)',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "AND (? <> 'on' OR (SELECT COUNT(*) FROM message_rules WHERE org_id = ? AND mode = ? AND state = 'on') < ?)`,",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND (? <> 'on' OR state = 'on'",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
  ],
  'src/worker/modules/passes/repo-authority.ts': [
    {
      text: "const target = tableAlias ? `${tableAlias}.org_id = ?` : '? IS NOT NULL';",
      reason:
        '`? IS NOT NULL` asserts the bound org id is present, so a null fails closed; every caller binds its row to authority.orgId',
    },
  ],
  'src/worker/modules/passes/repo-ops.ts': [
    {
      text: "AND (? = 0 OR status = 'active') ORDER BY id LIMIT ?`,",
      reason:
        'an activeOnly flag; the reissue org_id filter is built from what is present (null means platform-wide), unchanged from main',
    },
  ],
  'src/worker/modules/passes/repo-remove-compensate.ts': [
    {
      text: 'AND (? = 0 OR NOT EXISTS (SELECT 1 FROM scans s WHERE s.pass_id = passes.id))',
      reason:
        'a flag the service decides picks a variant of the statement; org_id and mode stay literal',
    },
  ],
  'src/worker/modules/sandbox/repo.ts': [
    {
      text: 'AND (? = 0 OR ${NEEDS_PROVIDER_RETIREMENT} OR ${PROVIDER_RETIREMENT_COMPLETE})',
      reason:
        'a flag adds a retirement guard; a test-pass sweep with mode = test literal and no org filter by design',
    },
  ],
  'src/worker/modules/scan/override-scope.ts': [
    {
      text: 'sql: `(q.actor_key = ? OR (? = 1 AND q.session_id IS NULL) OR (? IS NOT NULL AND q.session_id = ?) OR ${watch.sql})`,',
      reason:
        'fail-closed `? IS NOT NULL AND col = ?` and an admin flag inside one disjunct; the caller ANDs it with literal org_id and mode',
    },
  ],
  'src/worker/modules/scan/repo-act-claim.ts': [
    {
      text: "reason=CASE WHEN ? OR NOT (${pristine.sql}) THEN 'stale' ELSE NULL END",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/scan/repo-admission.ts': [
    {
      text: 'const selectedEventSql = `CASE WHEN ?=1 THEN ?',
      reason:
        'chooses the event of an optional admission-history filter; org_id is literal in the statements that use it',
    },
  ],
  'src/worker/modules/scan/repo-device.ts': [
    {
      text: "'? = 1 AND (contact_at <= ? OR contact_at IS NULL AND last_seen_at <= ?) AND (online_since IS NULL OR online_since <= ?)';",
      reason: 'a flag picks a variant of a by-scanner-id update; no org filter by design',
    },
    {
      text: 'contact_at = CASE WHEN ? = 1 THEN ? ELSE contact_at END',
      reason: 'a flag picks a variant of a by-scanner-id update; no org filter by design',
    },
    {
      text: 'OR (? = 1 AND (contact_at IS NULL OR contact_at <= ?)))`,',
      reason: 'a flag picks a variant of a by-scanner-id update; no org filter by design',
    },
  ],
  'src/worker/modules/scan/repo-scans.ts': [
    {
      text: "`UPDATE scans SET state = 'failed', reason = CASE WHEN ? OR (${AMBIGUOUS_SCAN})",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/scan/repo-watch-cover.ts': [
    {
      text: 'sql: `(? = 1 OR q.scanner_id IN (SELECT value FROM json_each(?)) OR q.session_id IN (SELECT value FROM json_each(?))',
      reason:
        'fail-closed `? IS NOT NULL AND col = ?` and an allOrg flag inside one disjunct; the caller ANDs it with literal org_id and mode',
    },
    {
      text: 'OR (? IS NOT NULL AND q.event_id = ?) OR q.zone_id IN (SELECT value FROM json_each(?)))`,',
      reason:
        'fail-closed `? IS NOT NULL AND col = ?` and an allOrg flag inside one disjunct; the caller ANDs it with literal org_id and mode',
    },
  ],
  'src/worker/modules/templates/repo-rollout.ts': [
    {
      text: 'WHERE ${MOVES_WITH_RELEASE} AND (? = 1 OR f.pass_id IS NOT NULL)',
      reason:
        'a flag the service decides picks a variant of the statement; org_id and mode stay literal',
    },
  ],
  'src/worker/modules/wallet-providers/repo-accounts-issued.ts': [
    {
      text: 'AND (? = 0 OR EXISTS (SELECT 1 FROM wallet_provider_instance_operations o',
      reason:
        'a flag the service decides picks a variant of the statement; org_id and mode stay literal',
    },
  ],
  'src/worker/modules/wallet-providers/repo-callbacks-state.ts': [
    {
      text: 'AND (? = 0 OR served_at IS NOT NULL) AND ${inserted}`,',
      reason: 'a flag adds a served-at guard; keyed by ref id, no org filter by design',
    },
  ],
  'src/worker/modules/wallet-providers/repo-google-managed.ts': [
    {
      text: "'UPDATE wallet_sa_keys SET state = ?, deleted_at = CASE WHEN ? = ? THEN ? ELSE deleted_at END WHERE key_name = ?',",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: 'JOIN wallet_credential_versions v ON v.credential_id = c.id AND v.id = COALESCE(?, c.current_version_id)',
      reason:
        'JOIN picks a credential version within v.credential_id = c.id; the caller checks the credential org',
    },
  ],
  'src/worker/modules/wallet-providers/repo-instance-desired.ts': [
    {
      text: "lifecycle = CASE WHEN ? = 'revoke' THEN 'revoking' ELSE 'active' END,",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "revoked_at = CASE WHEN ? = 'upsert' THEN NULL ELSE revoked_at END, updated_at = ?",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "AND (? = 'revoke' OR i.retirement_requested_at IS NULL)",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND ((? = 'upsert' AND (i.lifecycle = 'active' OR (i.lifecycle IN ('revoking', 'revoked')",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "OR (? = 'revoke' AND (i.lifecycle = 'active' OR (i.lifecycle = 'revoking' AND EXISTS (",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND (? = 'revoke' OR EXISTS (SELECT 1 FROM passes pass WHERE pass.id = i.pass_id",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND (? = 'revoke' OR EXISTS (SELECT 1 FROM wallet_provider_accounts account",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
  ],
  'src/worker/modules/wallet-providers/repo-instance-finish.ts': [
    {
      text: "WHEN ? = 1 THEN 'succeeded' WHEN ? = 1 AND op.attempts < 8 THEN 'retry' ELSE 'failed' END,",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: 'next_attempt_at = CASE WHEN proven.is_current AND ? = 0 AND ? = 1 AND op.attempts < 8',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: 'last_result_at = ?, completed_at = CASE WHEN NOT proven.is_current OR ? = 1 OR ? = 0 OR op.attempts >= 8',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/wallet-providers/repo-instance-mutations.ts': [
    {
      text: "lifecycle = CASE WHEN ? = 'revoke' THEN 'revoking' ELSE 'active' END,",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "revoked_at = CASE WHEN ? = 'upsert' THEN NULL ELSE revoked_at END, updated_at = ?",
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: "AND ((? = 'download' AND bearer.download_token = ?) OR (? = 'holder' AND bearer.owner_user_id = ?)))`;",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND ((? = 'download' AND holder.download_token = ?) OR (? = 'holder' AND holder.owner_user_id = ?))",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND ((? = 'upsert' AND (i.lifecycle = 'active' OR (i.lifecycle IN ('revoking', 'revoked')",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "OR (? = 'revoke' AND (i.lifecycle = 'active' OR (i.lifecycle = 'revoking' AND EXISTS (",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
  ],
  'src/worker/platform/workflow-runs.ts': [
    {
      text: '`UPDATE workflow_runs SET status = ?, finished_at = ?, error_code = ?, target_id = COALESCE(?, target_id),',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
    {
      text: 'run_guard = CASE WHEN ? THEN NULL ELSE run_guard END',
      reason: 'a SET or VALUES expression on a bound value, not a filter',
    },
  ],
  'src/worker/modules/channels/repo-replace.ts': [
    {
      text: "AND (? = 'never' OR pc.override = 'off' OR (pc.override IS NULL AND ? <> 'on'))`,",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
  ],
  'src/worker/modules/events/repo.ts': [
    {
      text: "WHERE p.id = ? AND p.org_id = ? AND (p.mode = ? OR ? = 'test')${guard ? ` AND (${guard.sql})` : ''}`,",
      reason:
        'a Test-mode fence may read either mode of the pass by id (unchanged from main); org_id is literal',
    },
  ],
  'src/worker/modules/wallet-providers/repo-samsung-card-state.ts': [
    {
      text: "AND ((st.state = 'ACTIVE' AND st.testing_mode_off = 'Y') OR (? = 'test' AND st.state IN ('ACTIVE', 'DRAFT', 'VERIFYING', 'VERIFIED')))",
      reason:
        "mode bind selects Test's wider card-state set; scope is candidate_id + account_id + account_epoch",
    },
  ],
  'src/worker/modules/wallet-providers/repo-sync-targets.ts': [
    {
      text: "AND ? = 'samsung' AND o.version = ? AND o.state = 'claimed'",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND ? = 'samsung' AND o.version = ? AND o.state IN ('claimed', 'uncertain')",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND i.provider = 'samsung' AND ? = 'samsung' AND o.version = ?",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
    {
      text: "AND i.provider = 'samsung' AND ? = 'samsung' AND o.version = ?",
      reason:
        'a bind compared with a literal (operation, provider or mode) picks a variant of the statement; its org_id and mode terms are separate and literal',
    },
  ],
};
