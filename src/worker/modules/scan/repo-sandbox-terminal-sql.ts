import { keyHoldsScope } from '../../platform/repo-api-key-sql.ts';

/**
 * How a key may act as a terminal. A till key lists `scans:write` and is bound to the terminal. A sandbox
 * key (`passes:write` held now, in an open sandbox) acts only as that sandbox's own terminal, named by
 * `developer_sandboxes.terminal_id`. It never holds `scans:write`, so it is no live credential. `k` is the key
 * alias. `tenant` renders the org and mode comparisons as the `{org}` and `{mode}` markers a grant condition
 * requires; the guard holds the key to Test and the commit adds an explicit Test check (`apiKeySandbox`).
 * Binds, in order: the terminal id, the `passes:write` scope, the terminal id.
 */
export function keyActsAsTerminalSql(tenant = false): {
  sql: string;
  bind: (scannerId: string) => string[];
} {
  const held = keyHoldsScope('k', 'passes:write');
  return {
    sql: `(
  (EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = 'scans:write')
    AND EXISTS (SELECT 1 FROM api_key_terminals t WHERE t.key_id = k.id AND t.scanner_id = ?))
  OR (${held.sql}
    AND EXISTS (SELECT 1 FROM developer_sandboxes d
      JOIN scanners s ON s.id = d.terminal_id
      WHERE d.org_id = ${tenant ? '{org}' : 'k.org_id'} AND d.closed_at IS NULL AND d.terminal_id = ?
        AND s.org_id = ${tenant ? '{org}' : 'k.org_id'} AND s.mode = ${tenant ? '{mode}' : 'k.mode'}
        AND s.kind = 'terminal' AND s.revoked_at IS NULL)))`,
    bind: (scannerId) => [scannerId, ...(held.params as string[]), scannerId],
  };
}
