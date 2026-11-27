const PERSONAL = 'SELECT id FROM orgs WHERE personal_user_id IS NOT NULL';

/**
 * `audit_log` rows a Platform key may read: personal orgs are private to their owner, whether the
 * row's `org_id` or the org it targets names one. Unaliased columns; no leading AND.
 */
export const PUBLIC_AUDIT_SQL = `(org_id IS NULL OR org_id NOT IN (${PERSONAL})) AND NOT COALESCE(target_type = 'org' AND target_id IN (${PERSONAL}), 0)`;
