// The wallet release rows the migrations write (wallet_provider_releases, migration 0226). check-migrations folds
// every migration into the final table and compares it with RELEASE (release.ts); deploy prints what a pending
// migration changes. Writes have one canonical form each, so a flip cannot hide in other SQL.

export type ReleaseProvider = 'google' | 'samsung';
export type ReleaseMode = 'live' | 'test';
export type ReleaseState = 'dark' | 'draining' | 'released';
export type ReleaseTable = Record<ReleaseProvider, Record<ReleaseMode, ReleaseState>>;

export interface ReleaseWrite {
  migration: string;
  /** `seed`: the rows the table is created with; `update`: a change of one row (a flip, a drain, back to dark). */
  kind: 'seed' | 'update';
  provider: ReleaseProvider;
  mode: ReleaseMode;
  state: ReleaseState;
}

const PROVIDERS: readonly ReleaseProvider[] = ['google', 'samsung'];
const MODES: readonly ReleaseMode[] = ['live', 'test'];

// Any write to the table, however the name is quoted or qualified (`"main"."wallet_provider_releases"`).
const ANY_WRITE =
  /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+(?:["`[]?\w+["`\]]?\s*\.\s*)?["`[]?wallet_provider_releases\b/gi;
const SEED =
  /INSERT INTO wallet_provider_releases \(provider, mode, state, changed_at\) VALUES((?:\s*\('(?:google|samsung)', '(?:live|test)', '(?:dark|draining|released)', \d+\),?)+);/g;
const SEED_ROW = /\('(google|samsung)', '(live|test)', '(dark|draining|released)', \d+\)/g;
const UPDATE =
  /UPDATE wallet_provider_releases SET state = '(dark|draining|released)', changed_at = \d+ WHERE provider = '(google|samsung)' AND mode = '(live|test)';/g;

export const RELEASE_UPDATE_FORM =
  "UPDATE wallet_provider_releases SET state = '<state>', changed_at = <ms> WHERE provider = '<provider>' AND mode = '<mode>';";

/** The release writes of one migration in order, or a problem when it writes the table any other way. */
export function releaseWrites(
  migration: string,
  sql: string,
): { writes: ReleaseWrite[]; problem: string | null } {
  const text = sql.replace(/--[^\n]*/g, '');
  const total = [...text.matchAll(ANY_WRITE)].length;
  const found: { at: number; writes: ReleaseWrite[] }[] = [];
  for (const m of text.matchAll(SEED))
    found.push({
      at: m.index,
      writes: [...(m[1] ?? '').matchAll(SEED_ROW)].map((r) => ({
        migration,
        kind: 'seed' as const,
        provider: r[1] as ReleaseProvider,
        mode: r[2] as ReleaseMode,
        state: r[3] as ReleaseState,
      })),
    });
  for (const m of text.matchAll(UPDATE))
    found.push({
      at: m.index,
      writes: [
        {
          migration,
          kind: 'update' as const,
          state: m[1] as ReleaseState,
          provider: m[2] as ReleaseProvider,
          mode: m[3] as ReleaseMode,
        },
      ],
    });
  if (found.length !== total)
    return {
      writes: [],
      problem: `${migration} writes wallet_provider_releases outside the one form: ${RELEASE_UPDATE_FORM}`,
    };
  return { writes: found.sort((a, b) => a.at - b.at).flatMap((f) => f.writes), problem: null };
}

/** The table after every migration (sorted by name), and the problems found on the way. */
export function foldReleases(migrations: readonly { name: string; sql: string }[]): {
  table: Partial<Record<`${ReleaseProvider}:${ReleaseMode}`, ReleaseState>>;
  problems: string[];
} {
  const table: Partial<Record<`${ReleaseProvider}:${ReleaseMode}`, ReleaseState>> = {};
  const problems: string[] = [];
  for (const { name, sql } of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
    const { writes, problem } = releaseWrites(name, sql);
    if (problem) problems.push(problem);
    for (const w of writes) table[`${w.provider}:${w.mode}`] = w.state;
  }
  return { table, problems };
}

/** Each cell where the migrations and RELEASE (release.ts) disagree, and every write problem. */
export function releaseMirrorProblems(
  migrations: readonly { name: string; sql: string }[],
  release: ReleaseTable,
): string[] {
  const { table, problems } = foldReleases(migrations);
  for (const provider of PROVIDERS)
    for (const mode of MODES) {
      const db = table[`${provider}:${mode}`] ?? 'missing';
      const code = release[provider][mode];
      if (db !== code)
        problems.push(
          `wallet release ${provider} ${mode}: the migrations leave it ${db}, RELEASE (release.ts) says ${code}. Change both in one PR.`,
        );
    }
  return problems;
}

/**
 * What the pending migrations change in the release, for the deploy log. Throws on a write in another form:
 * an unreadable flip is never "no change".
 */
export function pendingReleaseWrites(
  pending: readonly string[] | null,
  read: (name: string) => string,
): ReleaseWrite[] {
  return (pending ?? []).flatMap((name) => {
    const { writes, problem } = releaseWrites(name, read(name));
    if (problem) throw new Error(problem);
    return writes;
  });
}
