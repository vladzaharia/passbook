import { type Check, rawCheck, tenantMatch } from '../../platform/authority-checks.ts';
import { tenantCheck } from '../../platform/authority-cond.ts';
import { AuthorityError } from '../../platform/authority-error.ts';
import { type GrantPart, readPart } from '../../platform/authority-include.ts';
import { DEVICE_IDLE_MS } from './auth-store.ts';
import { effectiveReleaseIdSql, usedRelease } from './effective-release.ts';
import { channelEpochSql } from './repo-lookup.ts';
import { STAFF_IDLE_MS, STAFF_MAX_MS } from './staff-binding.ts';

/** The SQL behind the scan grant checks (`authority-checks.ts`, `scan-pass-checks.ts`, `scan-write-grant.ts`). */

/** A paired device must have been seen within the idle window. */
export const deviceAwakeCheck = (scannerId: string, now: number): Check =>
  rawCheck(
    'actor',
    `EXISTS (SELECT 1 FROM scanners s WHERE s.id = ? AND COALESCE(s.last_seen_at, s.paired_at, ?) + ? > ?)`,
    [scannerId, now, DEVICE_IDLE_MS, now],
  );

/** The API key a till scans with is live, bound to this terminal, in the grant's tenant and lists `scans:write`. */
export const apiKeyActsCheck = (keyId: string, scannerId: string, now: number): Check =>
  tenantCheck(
    'actor',
    `EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ? AND k.org_id = {org} AND k.mode = {mode}
       AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > ?)
       AND EXISTS (SELECT 1 FROM json_each(k.scopes) j WHERE j.type = 'text' AND j.value = 'scans:write')
       AND EXISTS (SELECT 1 FROM api_key_terminals t WHERE t.key_id = k.id AND t.scanner_id = ?))`,
    [keyId, now, scannerId],
  );

/** No staff was derived: the device must still have no valid binding (none, expired or disabled). */
export const noStaffBindingCheck = (scannerId: string, now: number): Check =>
  rawCheck(
    'staff',
    `NOT EXISTS (SELECT 1 FROM scanners s WHERE s.id = ? AND s.staff_id IS NOT NULL
              AND COALESCE(s.staff_seen_at >= ?, 0) AND COALESCE(s.staff_since >= ?, 0)
              AND EXISTS (SELECT 1 FROM scan_staff st WHERE st.id = s.staff_id AND st.disabled_at IS NULL))`,
    [scannerId, now - STAFF_IDLE_MS, now - STAFF_MAX_MS],
  );

export const sessionAcceptsTemplateCheck = (sessionId: string, templateId: string): Check =>
  rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM scanning_sessions ss, json_each(ss.accepts, '$.templateIds') j
            WHERE ss.id = ? AND j.value = ?)`,
    [sessionId, templateId],
  );

/** A mixed session admits the template through a template entry or one of its live events. */
export const sessionAdmitsTemplateCheck = (sessionId: string, templateId: string): Check =>
  tenantCheck(
    'config',
    `EXISTS (SELECT 1 FROM scanning_sessions ss WHERE ss.id = ? AND ss.org_id = {org}
      AND ss.mode = {mode} AND (
      EXISTS (SELECT 1 FROM json_each(ss.accepts, '$.templateIds') j WHERE j.value = ?)
      OR EXISTS (SELECT 1 FROM json_each(ss.accepts, '$.eventIds') je
        JOIN scan_events e ON e.id = je.value AND e.org_id = {org} AND e.mode = {mode}
          AND e.archived_at IS NULL
        JOIN scan_event_templates et ON et.event_id = e.id AND et.template_id = ?)))`,
    [sessionId, templateId, templateId],
  );

/** A mixed scope's events are all live at the epochs the guard captured; one bind for all of them. */
export const eventsAtEpochsCheck = (epochs: readonly [string, number][]): Check =>
  tenantCheck(
    'config',
    `NOT EXISTS (SELECT 1 FROM json_each(?) x WHERE NOT EXISTS (SELECT 1 FROM scan_events e
      WHERE e.id = json_extract(x.value, '$[0]') AND e.config_epoch = json_extract(x.value, '$[1]')
        AND e.org_id = {org} AND e.mode = {mode} AND e.archived_at IS NULL))`,
    [JSON.stringify(epochs)],
  );

export const scannerTemplateCheck = (scannerId: string, templateId: string): Check =>
  rawCheck(
    'config',
    `EXISTS (SELECT 1 FROM scanner_templates st WHERE st.scanner_id = ? AND st.template_id = ?)`,
    [scannerId, templateId],
  );

export const noScannerTemplatesCheck = (scannerId: string): Check =>
  rawCheck('config', `NOT EXISTS (SELECT 1 FROM scanner_templates st WHERE st.scanner_id = ?)`, [
    scannerId,
  ]);

export const noPendingTransferCheck = (passId: string): Check =>
  rawCheck(
    'lineage',
    `NOT EXISTS (SELECT 1 FROM pass_credential_transfers x WHERE x.pass_id = ? AND x.state = 'pending')`,
    [passId],
  );

/** The template must exist for the actor's org (archived is fine, use does not need the head); a reassignment is caught here. */
export const passTemplateUsableCheck = (passId: string): Check =>
  tenantCheck(
    'lineage',
    `EXISTS (SELECT 1 FROM passes p JOIN templates t ON t.id = p.template_id
        WHERE p.id = ? AND t.status != 'deleted' AND (t.org_id IS NULL OR t.org_id = {org}))`,
    [passId],
  );

/** None of the presented credential's references may be retired by a transfer in the grant's mode. */
export function credentialRefChecks(refs: readonly string[] = []): Check[] {
  if (!refs.length) return [];
  return [
    tenantCheck(
      'lineage',
      `NOT EXISTS (SELECT 1 FROM pass_credential_tombstones x
        WHERE x.org_id = {org} AND x.mode = {mode} AND x.credential_hash IN (SELECT value FROM json_each(?)))`,
      [JSON.stringify(refs)],
    ),
  ];
}

/** The current holder of a gate, named for a heads-up that lost the race. */
export const holderPart = (gate: { passId: string; actionId: string; scope: string }): GrantPart =>
  readPart(
    `SELECT g.state AS gate_state, g.last_at, g.last_scan_id AS gate_scan_id, g.count AS gate_count,
       s.id AS scan_id, s.at, s.state AS scan_state, s.action_id, s.scanner_id, s.staff_id,
       s.override_of, s.undone_by, sc.name AS scanner_name, st.name AS staff_name
     FROM scan_gates g LEFT JOIN scans s ON s.id = g.last_scan_id AND s.org_id = {org} AND s.mode = {mode}
     LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = {org} AND sc.mode = {mode}
     LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = {org}
     WHERE g.pass_id = ? AND g.action_id = ? AND g.scope = ? AND g.org_id = {org} AND g.mode = {mode}`,
    [gate.passId, gate.actionId, gate.scope],
  );

/** The scan that last moved a pass's presence, named for a heads-up whose admission lost the race. */
export const presenceHolderPart = (passId: string, scope: string): GrantPart =>
  readPart(
    `SELECT p.last_entry_at AS last_at, p.last_scan_id AS gate_scan_id,
       s.id AS scan_id, s.at, s.state AS scan_state, s.action_id, s.scanner_id, s.staff_id,
       s.override_of, s.undone_by, sc.name AS scanner_name, st.name AS staff_name
     FROM scan_presence p LEFT JOIN scans s ON s.id = p.last_scan_id AND s.org_id = {org} AND s.mode = {mode}
     LEFT JOIN scanners sc ON sc.id = s.scanner_id AND sc.org_id = {org} AND sc.mode = {mode}
     LEFT JOIN scan_staff st ON st.id = s.staff_id AND st.org_id = {org}
     WHERE p.pass_id = ? AND p.scope = ? AND p.org_id = {org} AND p.mode = {mode}`,
    [passId, scope],
  );

/** The scan closed (any outcome): what post-commit work for a heads-up is gated on. */
export const doneScanPredicate = (scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id = ? AND q.state = 'done')`,
  params: [scanId],
});

/** A scan row is closed with this outcome: what the post-commit work (counts, display, photo) is gated on. */
export const doneOkPredicate = (scanId: string) => ({
  sql: `EXISTS (SELECT 1 FROM scans q WHERE q.id = ? AND q.state = 'done' AND q.outcome = 'ok')`,
  params: [scanId],
});

/** What this scanner added and took today, with `amount` more, stays within its daily limit. Read in the grant's own transaction. */
export const dailyAmountCheck = (
  actorKey: string,
  since: number,
  amount: number,
  limit: number,
): Check =>
  tenantCheck(
    'retention',
    `COALESCE((SELECT SUM(s.amount) FROM scans s WHERE s.org_id = {org} AND s.mode = {mode}
       AND s.actor_key = ? AND s.action_kind IN ('add', 'take')
       AND s.outcome = 'ok' AND s.undone_by IS NULL AND s.at >= ?), 0) + ? <= ?`,
    [actorKey, since, amount, limit],
  );

/**
 * The pass is still used under the release the answer was evaluated under (`lineage`, 409
 * `SCAN_PASS_CHANGED`), by content: it holds when the release the pass would be used under now is
 * the one evaluated, or says the same about everything a scanner sees or may do (version,
 * content hash, adapter revision and capabilities, audience policy revision, org: FIX35's
 * `ownReleaseSaysSameSql`). A republish, or the first head of a legacy pass that is its own
 * pinned version, is no change; another version or adapter is. A legacy pass (no release) holds
 * while it has no head, or the head is its pinned version. A snapshot without a release is false.
 * In a grant that is the commit itself, so no read of this rides before it.
 *
 * The release SQL names org and mode columns of its own (`tenantCheck` refuses that), so this is a
 * hand-built `Check`, made only here: the pass is pinned by the grant's tenant (`tenantMatch`
 * against the actor row) and `assertReleaseCheckText` refuses, at render, any text whose `passes`
 * alias is not so pinned, that compares a tenant column to a bound value, that uses the reserved `g`
 * alias or an `a` other than `a.org_id` / `a.mode`, or that binds a different number of values.
 */
export function effectiveReleaseCheck(
  passId: string,
  snapshotRaw: string | null | undefined,
): Check {
  const used = usedRelease(snapshotRaw);
  if (used === false) return rawCheck('lineage', '0');
  return {
    reason: 'lineage',
    ok: (b, scope) => {
      if (scope === 'platform')
        throw new AuthorityError('GRANT_SCOPE_OVERRIDE', 'A release check needs a tenant.');
      const before = b.params.length;
      const head = `LEFT JOIN template_releases cur ON cur.id = ${effectiveReleaseIdSql('p')}`;
      const pinned = `p.id = ${b.bind(passId)} AND ${tenantMatch('passes', 'p', scope, 'a')}`;
      const same =
        used === null
          ? '(cur.id IS NULL OR cur.version = p.template_version)'
          : `(cur.id IS ${b.bind(used[0])} OR EXISTS (SELECT 1 FROM template_releases ev
              WHERE ev.id = ${b.bind(used[0])} AND ev.version = cur.version
                AND ev.content_hash = cur.content_hash
                AND ev.adapter_revision = cur.adapter_revision
                AND ev.adapter_capabilities = cur.adapter_capabilities
                AND ev.audience_policy_revision = cur.audience_policy_revision
                AND ev.org_id IS cur.org_id))`;
      const text = `EXISTS (SELECT 1 FROM passes p ${head} WHERE ${pinned} AND ${same})`;
      assertReleaseCheckText(text, b.params.length - before, scope);
      return text;
    },
  };
}

export function assertReleaseCheckText(
  text: string,
  bound: number,
  scope: 'org' | 'org_mode' | 'platform',
): void {
  const bad = (message: string) => new AuthorityError('GRANT_SCOPE_OVERRIDE', message);
  const aliases = [...text.matchAll(/\b(?:FROM|JOIN)\s+passes\s+(\w+)/gi)].map((m) => m[1] ?? '');
  if (aliases.length !== 1 || aliases[0] !== 'p')
    throw bad('A release check reads exactly one passes alias, p.');
  if (
    !text.includes('p.org_id = a.org_id') ||
    (scope === 'org_mode' && !text.includes('p.mode = a.mode'))
  )
    throw bad('The pass of a release check is pinned by the grant tenant.');
  if (/\b(?:org_id|mode)\s*(?:=|IS)\s*\?/i.test(text))
    throw bad('A release check never compares a tenant column to a bound value.');
  if (
    /\bg\./.test(text) ||
    [...text.matchAll(/\ba\.(\w+)/g)].some((m) => m[1] !== 'org_id' && m[1] !== 'mode')
  )
    throw bad('The aliases a and g are reserved in a release check.');
  if ((text.match(/\?/g)?.length ?? 0) !== bound)
    throw bad('A release check binds as many values as it has marks.');
}

/** A channel turned on or off, a policy or an org block saved since the read refuses the commit. */
export function channelEpochChecks(passId: string, epoch: string | undefined): Check[] {
  return epoch === undefined
    ? []
    : [
        tenantCheck(
          'lineage',
          `EXISTS (SELECT 1 FROM passes p WHERE p.id = ? AND p.org_id = {org} AND p.mode = {mode}
             AND ${channelEpochSql('{org}', '{mode}')} = ?)`,
          [passId, epoch],
        ),
      ];
}
