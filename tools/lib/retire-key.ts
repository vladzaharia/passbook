import { retireProblems, rootsInUse } from '../../src/worker/modules/keys/retire.ts';
import { CAPTURE_TABLE, ENVELOPE_TABLES } from '../../src/worker/modules/keys/rewrap-tables.ts';
import { EVIDENCE_ROOT, parseKekVersion } from '../../src/worker/platform/mac-key-config.ts';
import { secretNames } from './deploy-plan.ts';

const FRESH_MS = 15 * 60_000;

/** What the tool reads from production; the CLI wires these to `wrangler ... --remote`. */
export interface RetireDeps {
  /** `wrangler secret list --format json`. */
  secretList(): string;
  /** `wrangler d1 execute <db> --remote --json --command <sql>`. */
  query(sql: string): string;
  /** The local wrangler.jsonc vars: only compared with what the deployed Worker recorded. */
  vars: { MAC_KEY_VERSION?: unknown; MAC_KEY_VERSION_PREVIOUS?: unknown };
  now(): number;
}

/** The rows of a `wrangler d1 execute --json` output; anything else is an error, never "no rows". */
export function rowsOf(output: string): Record<string, unknown>[] {
  const parsed: unknown = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('unexpected output');
  return parsed.flatMap((entry: unknown) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      !('results' in entry) ||
      !Array.isArray(entry.results)
    )
      throw new Error('unexpected output');
    return entry.results as Record<string, unknown>[];
  });
}

const versions = (names: string[], prefix: string) =>
  names.flatMap((name) => {
    const match = new RegExp(`^${prefix}_V([1-9]\\d*)$`).exec(name);
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

const sameList = (a: readonly number[], b: unknown) =>
  Array.isArray(b) &&
  a.length === b.length &&
  [...a].sort().every((v, i) => v === [...b].sort()[i]);

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * Every reason `KEK_V<n>` must not be deleted now; empty when it may be. It judges the deployed Worker,
 * not this checkout: the ring and the MAC pins come from the record the cron writes every minute
 * (`keys.ring`), and the tool refuses when that is stale or the local wrangler.jsonc disagrees with it.
 * The rewrap and root conditions are the ones Status shows (`retireProblems`); this adds exact row counts
 * per table (not the cron's word), the live secret list and the staff PINs. A result of an unexpected
 * shape or length is a refusal.
 */
export function retireChecks(n: number, deps: RetireDeps): string[] {
  try {
    return check(n, deps);
  } catch {
    return ['A production query returned an unexpected result: nothing was checked.'];
  }
}

function check(n: number, deps: RetireDeps): string[] {
  const names = secretNames(deps.secretList());
  const state = new Map(
    rowsOf(
      deps.query(
        "SELECT key, value FROM settings WHERE scope = 'system' AND key IN ('keys.rewrapDone', 'keys.macRoots', 'keys.ring')",
      ),
    ).map((row) => [String(row.key), json(row.value)]),
  );
  const ring = state.get('keys.ring') ?? null;
  const ringProblems: string[] = [];
  if (!ring)
    ringProblems.push('keys.ring is missing: the cron has not recorded the deployed ring.');
  else {
    if (typeof ring.at !== 'number' || deps.now() - ring.at > FRESH_MS)
      ringProblems.push(
        'keys.ring is older than 15 minutes: the cron is not running on the latest deploy.',
      );
    for (const [name, key, recorded] of [
      ['MAC_KEY_VERSION', deps.vars.MAC_KEY_VERSION, ring.pin],
      ['MAC_KEY_VERSION_PREVIOUS', deps.vars.MAC_KEY_VERSION_PREVIOUS, ring.previous],
    ] as const)
      if ((parseKekVersion(key) ?? null) !== (recorded ?? null))
        ringProblems.push(
          `wrangler.jsonc ${name} (${String(key ?? 'unset')}) is not what the deployed Worker runs (${String(recorded ?? 'unset')}).`,
        );
    if (
      !sameList(versions(names, 'KEK'), ring.kek) ||
      !sameList(versions(names, 'MAC_ROOT'), ring.macRoot)
    )
      ringProblems.push(
        'The secret list and the ring the Worker recorded differ: wait for the next cron run.',
      );
  }
  if (ringProblems.length > 0 || !ring) return ringProblems;
  const kek = ring.kek as number[];
  const macRoot = ring.macRoot as number[];
  const settings = { pin: ring.pin, previous: ring.previous };
  const done = state.get('keys.rewrapDone') ?? null;
  const roots = state.get('keys.macRoots') ?? null;
  const fresh = typeof roots?.at === 'number' && deps.now() - roots.at <= FRESH_MS;
  const problems = retireProblems({
    n,
    kek,
    macRoot,
    ...settings,
    done,
    rootVerified: roots?.[String(n)] === 'match' && fresh,
    now: deps.now(),
  });
  if (rootsInUse(settings).includes(n) && roots?.[String(n)] === 'match' && !fresh)
    problems.push(
      'keys.macRoots is older than 15 minutes: the cron has not checked MAC_ROOT recently.',
    );
  const counts = ENVELOPE_TABLES.map((table) =>
    table === CAPTURE_TABLE
      ? `SELECT '${table}' AS t, count(*) AS n FROM ${table} WHERE html GLOB 'enc1:${n}.*' OR text GLOB 'enc1:${n}.*'`
      : `SELECT '${table}' AS t, count(*) AS n FROM ${table} WHERE kek_version = ${n}`,
  ).join(' UNION ALL ');
  const rows = rowsOf(deps.query(counts));
  const seen = new Set(rows.map((r) => String(r.t)));
  if (rows.length !== ENVELOPE_TABLES.length || ENVELOPE_TABLES.some((t) => !seen.has(t)))
    throw new Error('unexpected row count');
  for (const row of rows) {
    const found = count(row.n);
    if (found === null) throw new Error('unexpected count');
    if (found > 0) problems.push(`${found} rows in ${String(row.t)} still use KEK_V${n}.`);
  }
  if (!macRoot.includes(n)) {
    const pins = rowsOf(
      deps.query(
        `SELECT count(*) AS n FROM scan_staff WHERE COALESCE(pin_mac_version, ${EVIDENCE_ROOT}) = ${n}`,
      ),
    );
    const found = pins.length === 1 ? count(pins[0]?.n) : null;
    if (found === null) throw new Error('unexpected pin count');
    if (found > 0) problems.push(`${found} staff PINs are on root ${n}: reset them in Scanning.`);
  }
  return problems;
}
