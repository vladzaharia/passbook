import { retireProblems, rootsInUse } from '../../src/worker/modules/keys/retire.ts';
import { CAPTURE_TABLE, ENVELOPE_TABLES } from '../../src/worker/modules/keys/rewrap-tables.ts';
import { secretNames } from './deploy-plan.ts';

const ROOTS_FRESH_MS = 15 * 60_000;

/** What the tool reads from production; the CLI wires these to `wrangler ... --remote`. */
export interface RetireDeps {
  /** `wrangler secret list --format json`. */
  secretList(): string;
  /** `wrangler d1 execute <db> --remote --json --command <sql>`. */
  query(sql: string): string;
  vars: { MAC_KEY_VERSION?: unknown; MAC_KEY_VERSION_PREVIOUS?: unknown };
  now(): number;
}

/** The rows of a `wrangler d1 execute --json` output. */
export function rowsOf(output: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : []).flatMap((entry: unknown) =>
    entry && typeof entry === 'object' && 'results' in entry && Array.isArray(entry.results)
      ? (entry.results as Record<string, unknown>[])
      : [],
  );
}

const versions = (names: string[], prefix: string) =>
  names.flatMap((name) => {
    const match = new RegExp(`^${prefix}_V(\\d+)$`).exec(name);
    return match ? [Number(match[1])] : [];
  });

const json = (value: unknown): Record<string, unknown> | null => {
  try {
    const parsed: unknown = typeof value === 'string' ? JSON.parse(value) : null;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/**
 * Every reason `KEK_V<n>` must not be deleted now; empty when it may be. The rewrap and root conditions are
 * the ones Status shows (`retireProblems`); this adds exact row counts per table (not the cron's word), the
 * live secret list and the staff PINs.
 */
export function retireChecks(n: number, deps: RetireDeps): string[] {
  const names = secretNames(deps.secretList());
  const kek = versions(names, 'KEK');
  const macRoot = versions(names, 'MAC_ROOT');
  const settings = { pin: deps.vars.MAC_KEY_VERSION, previous: deps.vars.MAC_KEY_VERSION_PREVIOUS };
  const state = new Map(
    rowsOf(
      deps.query(
        "SELECT key, value FROM settings WHERE scope = 'system' AND key IN ('keys.rewrapDone', 'keys.macRoots')",
      ),
    ).map((row) => [String(row.key), json(row.value)]),
  );
  const done = state.get('keys.rewrapDone') ?? null;
  const roots = state.get('keys.macRoots') ?? null;
  const fresh = typeof roots?.at === 'number' && deps.now() - roots.at <= ROOTS_FRESH_MS;
  const problems = retireProblems({
    n,
    kek,
    macRoot,
    ...settings,
    done,
    rootVerified: roots?.[String(n)] === 'match' && fresh,
    now: deps.now(),
  });
  if (
    rootsInUse({ kek, macRoot, ...settings }).includes(n) &&
    roots?.[String(n)] === 'match' &&
    !fresh
  )
    problems.push(
      'keys.macRoots is older than 15 minutes: the cron has not checked MAC_ROOT recently.',
    );
  const counts = ENVELOPE_TABLES.map((table) =>
    table === CAPTURE_TABLE
      ? `SELECT '${table}' AS t, count(*) AS n FROM ${table} WHERE html GLOB 'enc1:${n}.*' OR text GLOB 'enc1:${n}.*'`
      : `SELECT '${table}' AS t, count(*) AS n FROM ${table} WHERE kek_version = ${n}`,
  ).join(' UNION ALL ');
  for (const row of rowsOf(deps.query(counts)))
    if (Number(row.n) > 0)
      problems.push(`${String(row.n)} rows in ${String(row.t)} still use KEK_V${n}.`);
  if (!macRoot.includes(n)) {
    const oldest = Math.min(...kek, ...macRoot);
    const pins = rowsOf(
      deps.query(
        `SELECT count(*) AS n FROM scan_staff WHERE COALESCE(pin_mac_version, ${oldest}) = ${n}`,
      ),
    );
    if (Number(pins[0]?.n ?? 0) > 0)
      problems.push(`${String(pins[0]?.n)} staff PINs are on root ${n}: reset them in Scanning.`);
  }
  return problems;
}
