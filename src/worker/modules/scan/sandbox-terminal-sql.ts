import { SANDBOX_TERMINAL_NAME } from '../../../shared/copy/developer.ts';

/**
 * How a key may act as a terminal. A till key lists `scans:write` and is bound to the terminal. A sandbox
 * key (Test, `passes:write`, in a developer org: the `developer` preset, which only those orgs hold) acts only
 * as that org's own sandbox terminal. It never holds `scans:write`, so it is no live credential. `k` is the key
 * alias. `tenant` renders the org and mode comparisons as the `{org}` and `{mode}` markers a grant condition
 * requires; the guard (guard-api-key.ts) holds the key to Test.
 */
export const keyActsAsTerminalSql = (tenant = false) => `(
  (EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = 'scans:write')
    AND EXISTS (SELECT 1 FROM api_key_terminals t WHERE t.key_id = k.id AND t.scanner_id = ?))
  OR (EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = 'passes:write')
    AND EXISTS (SELECT 1 FROM org_entitlements e WHERE e.org_id = ${tenant ? '{org}' : 'k.org_id'} AND e.preset = 'developer')
    AND EXISTS (SELECT 1 FROM scanners s WHERE s.id = ?
      AND ${tenant ? 's.org_id = {org} AND s.mode = {mode}' : 's.org_id = k.org_id AND s.mode = k.mode'}
      AND s.kind = 'terminal' AND s.name = '${SANDBOX_TERMINAL_NAME}' AND s.revoked_at IS NULL)))`;
