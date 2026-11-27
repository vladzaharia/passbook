// Replays the SQL the worker tests prepared through SQLite 3.54.1 (the build whose cursor-count rule
// broke workerd 1.20261110) with D1's limits, so a statement near the limit fails here, not in prod.
// Corpus: .wrangler/sql-corpus/*.jsonl, written by the worker project (test/setup/sql-corpus.ts).
// Known failures are pinned in tools/sql-depth-allowlist.json; P2 to P4 of the workerd-sql-limit plan empty it.
// Usage: node tools/check-sql-depth.ts [corpus dir] [--write-allowlist]
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

const root = resolve(import.meta.dirname, '..');
export const ALLOWLIST_PATH = join(root, 'tools/sql-depth-allowlist.json');
export const EXPECTED_SQLITE = '3.54.1';

// D1's documented limits (SQLITE_LIMIT_*).
const D1_LIMITS: Record<string, number> = {
  SQLITE_LIMIT_EXPR_DEPTH: 100,
  SQLITE_LIMIT_COMPOUND_SELECT: 5,
  SQLITE_LIMIT_VARIABLE_NUMBER: 100,
  SQLITE_LIMIT_SQL_LENGTH: 100_000,
  SQLITE_LIMIT_FUNCTION_ARG: 127,
  SQLITE_LIMIT_LIKE_PATTERN_LENGTH: 50,
  SQLITE_LIMIT_TRIGGER_DEPTH: 10,
};

// Other prepare errors come from test-only DDL and statements that need a different schema.
const LIMIT_ERROR =
  /nested too deep|Expression tree is too large|too many terms in compound SELECT|too many SQL variables|string or blob too big|too many arguments|LIKE or GLOB pattern is too complex/i;

export interface CorpusEntry {
  sql: string;
  test: string | null;
}
export interface Finding {
  fingerprint: string;
  error: string;
  sql: string;
  test: string | null;
}
export interface AllowEntry {
  fingerprint: string;
  error: string;
  sql: string;
}

export const fingerprint = (sql: string) =>
  createHash('sha256').update(sql.replace(/\s+/g, ' ').trim()).digest('hex').slice(0, 12);

export function readCorpus(dir: string): CorpusEntry[] {
  const seen = new Map<string, CorpusEntry>();
  for (const name of readdirSync(dir)
    .filter((n) => n.endsWith('.jsonl'))
    .sort()) {
    for (const line of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!line) continue;
      const entry = JSON.parse(line) as Partial<CorpusEntry>;
      if (typeof entry.sql === 'string' && !seen.has(entry.sql))
        seen.set(entry.sql, { sql: entry.sql, test: entry.test ?? null });
    }
  }
  return [...seen.values()];
}

type Db = {
  exec: (sql: string) => unknown;
  prepare: (sql: string) => { finalize: () => void };
  pointer?: number;
  selectValue: (sql: string) => unknown;
};
export interface Oracle {
  version: string;
  /** Returns the limit error for a statement, or null when it prepares or fails for another reason. */
  check: (sql: string) => string | null;
}

export async function openOracle(migrationsDir = join(root, 'migrations')): Promise<Oracle> {
  const sqlite3 = await sqlite3InitModule();
  const db = new sqlite3.oo1.DB(':memory:') as unknown as Db;
  for (const file of readdirSync(migrationsDir)
    .filter((n) => n.endsWith('.sql'))
    .sort())
    db.exec(readFileSync(join(migrationsDir, file), 'utf8'));
  const capi = sqlite3.capi as unknown as Record<string, number> & {
    sqlite3_limit: (db: number, id: number, value: number) => number;
  };
  // Limits go on after the schema loads: migrations legitimately use wider statements than D1 allows per query.
  for (const [name, value] of Object.entries(D1_LIMITS))
    capi.sqlite3_limit(db.pointer ?? 0, capi[name] as number, value);
  return {
    version: String(db.selectValue('SELECT sqlite_version()')),
    check(sql) {
      try {
        db.prepare(sql).finalize();
        return null;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return LIMIT_ERROR.test(message) ? message : null;
      }
    },
  };
}

export function findFailures(oracle: Oracle, corpus: CorpusEntry[]): Finding[] {
  const out: Finding[] = [];
  for (const { sql, test } of corpus) {
    const error = oracle.check(sql);
    if (error) out.push({ fingerprint: fingerprint(sql), error, sql, test });
  }
  return out;
}

export interface Verdict {
  fresh: Finding[];
  known: Finding[];
  /** Allowlisted statements that no longer fail in this corpus (a shard sees only part of the suite). */
  cleared: AllowEntry[];
}

export function judge(findings: Finding[], allow: AllowEntry[]): Verdict {
  const allowed = new Set(allow.map((a) => a.fingerprint));
  const failing = new Set(findings.map((f) => f.fingerprint));
  return {
    fresh: findings.filter((f) => !allowed.has(f.fingerprint)),
    known: findings.filter((f) => allowed.has(f.fingerprint)),
    cleared: allow.filter((a) => !failing.has(a.fingerprint)),
  };
}

export const readAllowlist = (path = ALLOWLIST_PATH) =>
  JSON.parse(readFileSync(path, 'utf8')) as AllowEntry[];

const excerpt = (sql: string) => sql.replace(/\s+/g, ' ').trim().slice(0, 160);

async function main() {
  const args = process.argv.slice(2);
  const dir = resolve(args.find((a) => !a.startsWith('--')) ?? join(root, '.wrangler/sql-corpus'));
  const corpus = readCorpus(dir);
  if (corpus.length === 0) {
    process.stderr.write(`check-sql-depth: no statements in ${dir}; run the worker tests first\n`);
    process.exit(1);
  }
  const oracle = await openOracle();
  if (oracle.version !== EXPECTED_SQLITE) {
    process.stderr.write(
      `check-sql-depth: oracle is SQLite ${oracle.version}, expected ${EXPECTED_SQLITE}\n`,
    );
    process.exit(1);
  }
  const findings = findFailures(oracle, corpus);
  if (args.includes('--write-allowlist')) {
    const merged = new Map(readAllowlist().map((a) => [a.fingerprint, a]));
    for (const f of findings)
      merged.set(f.fingerprint, {
        fingerprint: f.fingerprint,
        error: f.error,
        sql: excerpt(f.sql),
      });
    const sorted = [...merged.values()].sort(
      (a, b) => a.sql.localeCompare(b.sql) || a.fingerprint.localeCompare(b.fingerprint),
    );
    writeFileSync(ALLOWLIST_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
    process.stdout.write(`check-sql-depth: allowlist now ${sorted.length} statements\n`);
    return;
  }
  const { fresh, known, cleared } = judge(findings, readAllowlist());
  const out = process.stdout;
  out.write(
    `check-sql-depth: ${corpus.length} statements, SQLite ${oracle.version}, ${known.length} known failures (allowlist ${readAllowlist().length}), ${fresh.length} new, ${cleared.length} allowlisted not failing here\n`,
  );
  for (const f of known) out.write(`  known ${f.fingerprint} ${f.error}: ${excerpt(f.sql)}\n`);
  for (const a of cleared)
    out.write(
      `  cleared ${a.fingerprint}: remove from tools/sql-depth-allowlist.json if it passes in the full corpus\n`,
    );
  if (fresh.length > 0) {
    for (const f of fresh)
      process.stderr.write(
        `NEW ${f.fingerprint} ${f.error}\n  first test: ${f.test ?? 'unknown'}\n  ${excerpt(f.sql)}\n`,
      );
    process.stderr.write(
      `check-sql-depth: ${fresh.length} statements fail and are not in tools/sql-depth-allowlist.json\n`,
    );
    process.exit(1);
  }
}

if (import.meta.main) await main();
