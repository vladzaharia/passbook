// Authority-redesign scope check (docs/design/authority-epochs.md sections 1.2, 1.3 and 7.1).
// Every file matching a fence pattern needs one owner in Appendix A, and the lint rules apply.
// `npm run check:rules` runs it with --strict: any finding fails the build.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import {
  AUTHORITY_TABLES,
  GUARDED_TABLES,
  ORG_BEARING_TABLES,
} from '../src/worker/platform/authority-tables.ts';
import {
  DYNAMIC_WRITE_ALLOWLIST,
  RAW_WRITE_ALLOWLIST,
  REPLACE_ALLOWLIST,
  UNTENANTED_CHECK_ALLOWLIST,
} from './authority-scope-allowlists.ts';
import { scanBans } from './authority-scope-bans.ts';
import { opaqueFindings, opaqueHash } from './authority-scope-opaque.ts';
import { OPAQUE_ALLOWLIST } from './authority-scope-opaque-allowlist.ts';
import { fragmentPlacement } from './authority-scope-placement.ts';
import {
  type Cx,
  describeStatement,
  fingerprint,
  importsOf,
  stripComments,
  usesOf,
} from './authority-scope-statements.ts';

export {
  DYNAMIC_WRITE_ALLOWLIST,
  RAW_WRITE_ALLOWLIST,
  REPLACE_ALLOWLIST,
  UNTENANTED_CHECK_ALLOWLIST,
};

const root = resolve(import.meta.dirname, '..');
const DOC = 'docs/design/authority-epochs.md';

export type Rule =
  | 'unowned'
  | 'replace'
  | 'raw-guarded-write'
  | 'dynamic-write'
  | 'updated-at-predicate'
  | 'request-bound-grant-org'
  | 'untenanted-check'
  | 'job-context'
  | 'job-authority-import'
  | 'builder-internal'
  | 'forged-statement'
  | 'banned'
  | 'stale-allowlist'
  | 'allowlist-growth';

export interface Finding {
  rule: Rule;
  file: string;
  detail: string;
}

/** Fence patterns of section 7.1. A file matching any needs exactly one Appendix A owner. */
const FENCE_PATTERNS: [string, RegExp][] = [
  ['updated_at = ?', /updated_at\s*=\s*\?/],
  ['tenantPassAuthoritySql', /tenantPassAuthoritySql|tenantPassWriteSql/],
  ['repo-secret-binds', /repo-secret-binds/],
  ['credentialRefKeysetSql', /credentialRefKeysetSql/],
  ['platformAdminSessionSql', /platformAdminSessionSql/],
  [
    'active release',
    /\bactiveRelease(?:Predicate|Join|IdSql|BindingPredicate|Sql)\w*|noScopedReleaseSql/,
  ],
  ['changes()', /\bchanges\(\)/],
];

const GUARDED = [...Object.keys(GUARDED_TABLES), ...AUTHORITY_TABLES].join('|');
// A target may carry a schema prefix or quotes (`main.passes`, `"passes"`), which the match still names.
const QUOTE = '["`\\[]?';
const SCHEMA = '(?:(?:main|temp)\\s*\\.\\s*)?';
// `UPDATE t [AS] x [INDEXED BY i | NOT INDEXED] SET`; INSERT and DELETE match on the table name alone.
const ALIAS = '(?:\\s+(?:AS\\s+)?(?!SET\\b|INDEXED\\b|NOT\\b)(?:[a-z_]\\w*|\\$\\{[^}]*\\}))?';
const INDEXED = '(?:\\s+INDEXED\\s+BY\\s+\\w+|\\s+NOT\\s+INDEXED)?';
const WRITE = new RegExp(
  `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|DELETE\\s+FROM)\\s+${SCHEMA}${QUOTE}(${GUARDED})\\b|\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${SCHEMA}${QUOTE}(${GUARDED})\\b${QUOTE}${ALIAS}${INDEXED}\\s+SET\\s+([^;]*?)(?:\\bWHERE\\b|[\`'"]|$)`,
  'gis',
);
/** Helpers whose table is an argument: a guarded table literal there is a raw write too. */
const HELPER_WRITE = new RegExp(
  `\\b(?:deleteInBatches\\(\\s*[\\w.]+\\s*,\\s*|casUpdate\\([^)]*?\\btable\\s*:\\s*)['"\`](${GUARDED})['"\`]`,
  'g',
);
const HEAD = '\\b(?:INSERT(?:\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|DELETE\\s+FROM)';
const CONCAT = '(?:\\s+[\\w.]*)?\\s*[\'"`]\\s*\\+';
/**
 * A write whose target is interpolated, or SQL text concatenated onto a write head. A lone `update` is
 * also a JS word, so a concatenated UPDATE must be upper-case and an interpolated one must reach SET.
 */
const DYNAMIC_WRITE = [
  new RegExp(`${HEAD}\\s+${SCHEMA}\\$\\{|${HEAD}${CONCAT}`, 'gi'),
  new RegExp(
    `\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${SCHEMA}\\$\\{[^}]*\\}(?:\\s+(?:AS\\s+)?\\w+)?\\s+(?:SET|INDEXED|NOT)\\b`,
    'gi',
  ),
  new RegExp(`\\bUPDATE(?:\\s+OR\\s+[A-Z]+)?${CONCAT}`, 'g'),
];
/** Builder internals: the statement token, its factory and the batch's private prepare. */
const BUILDER_INTERNAL = /\b(?:BUILDER|newGrantedStatement|prepareOf|registerPrepare)\b/;
/** Columns that may change outside a grant: session idle slide, scanner and key last-use stamps (`contact_at`: the server's stamp of a device's last request that is not an upload; `contact_prev_at`, `online_since`: its reconnect grace). */
const STAMP_ONLY =
  /^(?:\s*(?:last_seen_at|contact_at|contact_prev_at|online_since|last_ip_prefix|staff_seen_at|idle_expires_at|last_used_at)\s*=\s*[^,]+,?)+\s*$/is;
/** Files that name `mode` in a builder call on purpose. Each needs the reason. */
const TENANT_KEY_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/retention/repo-floors.ts':
    'a platform settings save (a retention maximum or default moved) names the org each floor belongs to; the org grant branch names none',
  'src/worker/modules/retention/repo-holds.ts':
    'a platform admin places a legal hold on an org: the platform grant names it; the org grant branch names none',
  'src/worker/modules/orgs/repo-entitlements.ts':
    "a platform admin sets one org's preset and overrides: the platform grant names the org it writes; no org grant reaches these tables",
  'src/worker/modules/scan/repo-scanners.ts':
    'the scanner mode move is the one org-scope write that names its destination mode; the source mode is checked with exactlyOne in the same grant',
  'src/worker/modules/developer/repo-grants.ts':
    'a platform-scope job grant makes a sandbox org in one batch: no tenant exists yet, so its membership and sandbox rows name the org the same batch inserts; the close update names the one org the sweep read',
  'src/worker/modules/developer/repo-grants-reset.ts':
    'a platform-scope job grant restarts the quickstart track of, or reopens, the one sandbox org the service read for the signed-in person: it names that org and person (a platform grant pins no tenant), after the same live-session check as the close',
  'src/worker/modules/org-lifecycle/repo-state.ts':
    'a platform close or reopen names the org whose developer sandbox it syncs (a platform grant pins no tenant)',
  'src/worker/modules/orgs/repo-personal.ts':
    "a platform-scope grant makes the signing-in admin's personal org in one batch: its invitation and membership name the org the same batch inserts; the builder pins every row to the grant's org and user (authority-personal.ts)",
  'src/worker/platform/entitlements.ts':
    'the entitlements row of a new org names the org the same batch just inserted; the one helper every org-insert path calls',
};
/** Also `UPDATE OR REPLACE`, which evicts a row through any unique key. */
/** A builder call whose arguments name `org_id` or `mode`: the grant supplies both. */
const BUILDER_TENANT_KEY =
  /\b(?:g|grant)\.(?:update|delete|joined|insertSelect|insertJoined|upsert)\([^;]*?['"]?\b(?:org_id|mode)\b['"]?\s*[:,\]]/s;
/** An `include` part whose SQL compares org_id or mode to a bound value instead of `{org}` and `{mode}`. */
const PART_TENANT_BIND =
  /\b(?:writePart|readPart)\(\s*(['"`])(?:(?!\1)[\s\S])*?\b(?:org_id|mode)\s*=\s*\?/;
const UPDATED_AT_PREDICATE = /\bWHERE\b[^;`]*?\bupdated_at\s*=\s*\?/is;
/** The number of reviewed raw-write files. Removing one lowers it; a new entry fails until a design decision raises it. */
// 31: outbound webhooks add repo-delivery-state.ts and repo-retention.ts (design-webhooks.md section 11.3);
// the trust pack adds retention/repo-receipts.ts and retention/repo-sweep.ts;
// 32: delivery channels add channels/repo.ts, the insert-once copy evidence (design-channels.md N3). The invitation page
// moves the invitation accept from orgs/repo-members.ts into idp/invitations/repo-writes.ts (setup, claim and accept share the
// invitation secret as their authority): one file out, one in.
export const RAW_WRITE_ALLOWLIST_LIMIT = 32;
const REPLACE = /\bOR\s+REPLACE\b|\bREPLACE\s+INTO\b/i;

const TENANT_TABLES = new Set([
  ...Object.entries(GUARDED_TABLES)
    .filter(([, t]) => t.org !== null)
    .map(([name]) => name),
  ...ORG_BEARING_TABLES,
]);

/** The body of the JS string literal opening at `at` (quote included); `${...}` reads as `x`. */
function literalBody(text: string, at: number): string {
  const quote = text[at];
  let out = '';
  for (let i = at + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      out += text[++i] ?? '';
    } else if (ch === quote) {
      return out;
    } else if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      let depth = 0;
      for (i++; i < text.length; i++) {
        if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      out += 'x';
    } else out += ch;
  }
  return out;
}

/** The text inside the parenthesis that opens at `open`. */
function group(text: string, open: number): string {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(open + 1, i);
  }
  return text.slice(open + 1);
}

/**
 * Tenant tables a `rawCheck` reads under a positive EXISTS without a tenant term (`a.org_id`). A NOT EXISTS
 * over another tenant's row only refuses more, so negated bodies are skipped.
 */
export function untenantedChecks(source: string): string[] {
  const out = new Set<string>();
  for (const m of source.matchAll(/\brawCheck\(\s*(?:'[^']*'|"[^"]*"|[\w.]+)\s*,\s*(?=['"`])/g)) {
    let sql = literalBody(source, (m.index ?? 0) + m[0].length).replace(/'(?:[^']|'')*'/g, "''");
    for (let n = /\bNOT\s+EXISTS\s*\(/i.exec(sql); n; n = /\bNOT\s+EXISTS\s*\(/i.exec(sql)) {
      const open = n.index + n[0].length - 1;
      const body = group(sql, open);
      sql = `${sql.slice(0, n.index)}${' '.repeat(n[0].length + body.length + 1)}${sql.slice(open + body.length + 2)}`;
    }
    for (const e of sql.matchAll(/\bEXISTS\s*\(/gi)) {
      const body = group(sql, (e.index ?? 0) + e[0].length - 1);
      if (/\ba\.org_id\b/.test(body)) continue;
      // A comma join names its later tables after a comma: `FROM passes p, scans s`.
      for (const t of body.matchAll(
        /\b(?:FROM|JOIN)\s+([a-z_]\w*)|,\s*([a-z_]\w*)\s+(?:AS\s+)?[a-z_]\w*/gi,
      ))
        if (TENANT_TABLES.has((t[1] ?? t[2] ?? '').toLowerCase()))
          out.add((t[1] ?? t[2] ?? '').toLowerCase());
    }
  }
  return [...out];
}

const WALLET_MODULE = 'src/worker/modules/wallet-providers/';
const notProduction = (rel: string) =>
  !/\.tsx?$/.test(rel) ||
  /\.test\.tsx?$/.test(rel) ||
  /(?:fixtures?|test-kit|test-support|test-helpers?|testing)[a-z0-9-]*\.tsx?$/.test(rel) ||
  !rel.startsWith('src/worker/');
const skipFile = (rel: string) => notProduction(rel) || rel.startsWith(WALLET_MODULE);

/**
 * The provider track is exempt from this lint (it writes its wallet_* tables raw), except for the guarded
 * ones: the credential, version, event and check tables and the enrolment events (0112). A write to one of
 * them from the module is a raw-guarded-write like any other, so the check job's grant is the only way in.
 */
const WALLET_GUARDED = new Set(Object.keys(GUARDED_TABLES).filter((t) => t.startsWith('wallet_')));
function scanWalletModule(rel: string, text: string): Finding[] {
  const pinned = [...(RAW_WRITE_ALLOWLIST[rel]?.writes ?? [])];
  const found: Finding[] = [];
  for (const id of rawWriteStatements(text)) {
    const table = id.slice(0, id.indexOf(':'));
    if (!WALLET_GUARDED.has(table)) continue;
    const at = pinned.indexOf(id);
    if (at !== -1) pinned.splice(at, 1);
    else found.push({ rule: 'raw-guarded-write', file: rel, detail: `raw write to ${table}` });
  }
  return found;
}

const isAuthorityFile = (rel: string) =>
  /^src\/worker\/platform\/(?:authority|job-authority)[a-z-]*\.ts$/.test(rel);

/** `a/{b,c}.ts` -> two paths. One level of braces is all Appendix A uses. */
export function expandBraces(pattern: string): string[] {
  const m = /\{([^{}]+)\}/.exec(pattern);
  if (!m) return [pattern];
  return (m[1] ?? '').split(',').flatMap((part) => expandBraces(pattern.replace(m[0], part)));
}

export interface Owners {
  exact: Map<string, string>;
  globs: [RegExp, string][];
}

/** Reads Appendix A: `**WPx:**` headings and backticked paths, relative to src/worker/modules/ unless src/. */
export function parseAppendixA(markdown: string): Owners {
  const start = markdown.indexOf('## Appendix A');
  const end = markdown.indexOf('## Appendix B');
  const owners: Owners = { exact: new Map(), globs: [] };
  let wp = '';
  for (const line of markdown.slice(start, end).split('\n')) {
    const heading = /^\*\*(WP[^*:]*?)(?: \([^)]*\))?:\*\*(.*)$/.exec(line);
    if (heading) wp = (heading[1] ?? '').trim();
    const body = heading ? (heading[2] ?? '') : line;
    if (!wp) continue;
    for (const [, token] of body.matchAll(/`([^`]+)`/g)) {
      for (const raw of expandBraces(token ?? '')) {
        const scoped = raw.replace(/^`|`$/g, '');
        const prefixed = /^(?:src|tools|test)\//.test(scoped)
          ? scoped
          : `src/worker/modules/${scoped}`;
        const path = /^[A-Za-z0-9_./-]+\.ts$/.test(prefixed) ? prefixed : prefixed;
        if (/[*]/.test(path)) {
          const re = new RegExp(
            `^${path.replace(/[.+^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`,
          );
          owners.globs.push([re, wp]);
        } else {
          owners.exact.set(path, wp);
        }
      }
    }
  }
  return owners;
}

export function ownerOf(rel: string, owners: Owners): string | null {
  return owners.exact.get(rel) ?? owners.globs.find(([re]) => re.test(rel))?.[1] ?? null;
}

/** The raw writes of one file, each with the constant that holds it (the file's own, not its imports'). */
function writeEntries(
  source: string,
  cx?: Cx,
): {
  table: string;
  id: string;
  holder: string | null;
  exported: boolean;
  calls: string[];
  text: string;
}[] {
  const stripped = stripComments(source, cx);
  const { text } = stripped;
  const out: {
    table: string;
    id: string;
    holder: string | null;
    exported: boolean;
    calls: string[];
    text: string;
  }[] = [];
  for (const m of text.matchAll(WRITE)) {
    if (m[2] && STAMP_ONLY.test(m[3] ?? '')) continue;
    const table = m[1] ?? m[2] ?? '';
    const { text: statement, holder, exported, calls } = describeStatement(stripped, m.index ?? 0);
    out.push({
      table,
      id: `${table}:${fingerprint(statement)}`,
      holder,
      exported,
      calls,
      text: statement,
    });
  }
  for (const m of text.matchAll(HELPER_WRITE)) {
    const open = (m.index ?? 0) + m[0].indexOf('(');
    out.push({
      table: m[1] ?? '',
      id: `${m[1] ?? ''}:${fingerprint(group(text, open))}`,
      holder: null,
      exported: false,
      calls: [],
      text: '',
    });
  }
  return out;
}

/** Calls interpolated into the raw writes of a file that its pins cannot see into, as `table:fn`. */
export function uninlinedWriteCalls(
  source: string,
  where?: { rel: string; files: ReadonlyMap<string, string> },
): string[] {
  const cx = where && { ...where, seen: new Set<string>() };
  return writeEntries(source, cx).flatMap((e) => e.calls.map((c) => `${e.table}:${c}`));
}

/** Placement findings of the caller-built fragments in the raw writes of a file (`fragmentPlacement`). */
export function fragmentFindings(
  source: string,
  where?: { rel: string; files: ReadonlyMap<string, string> },
): string[] {
  const cx = where && { ...where, seen: new Set<string>() };
  return [...new Set(writeEntries(source, cx).flatMap((e) => fragmentPlacement(e.text)))];
}

/**
 * A raw write to a guarded table, as `table:fingerprint` of its statement (comments never count). With the
 * file set, a constant imported from a file inside it is inlined, and each use of an exported constant that
 * holds a write adds that write's `id@use` here, so a new file that runs a pinned write is a new statement.
 */
export function rawWriteStatements(
  source: string,
  where?: { rel: string; files: ReadonlyMap<string, string> },
): string[] {
  const cx = where && { ...where, seen: new Set<string>() };
  const stripped = stripComments(source, cx);
  const out: string[] = [];
  for (const e of writeEntries(source, cx)) {
    out.push(e.id);
    // A pinned constant run from another call site is another statement.
    if (e.holder) for (let n = usesOf(stripped, e.holder); n > 0; n--) out.push(`${e.id}@use`);
  }
  if (cx)
    for (const imported of importsOf(stripped)) {
      const entries = writeEntries(cx.files.get(imported.file) ?? '', {
        rel: imported.file,
        files: cx.files,
        seen: new Set(),
      }).filter((e) => e.exported && e.holder === imported.name);
      const uses = usesOf(stripped, imported.local);
      for (const e of entries) for (let n = uses; n > 0; n--) out.push(`${e.id}@use`);
    }
  return out.sort();
}

/** Guarded tables a file writes with raw SQL (a stamp-only update does not count). */
export function rawGuardedWrites(text: string): string[] {
  return rawWriteStatements(text).map((id) => id.slice(0, id.indexOf(':')));
}

export function scanFile(
  rel: string,
  text: string,
  owners: Owners,
  files?: ReadonlyMap<string, string>,
): Finding[] {
  if (rel.startsWith(WALLET_MODULE) && !notProduction(rel)) return scanWalletModule(rel, text);
  if (skipFile(rel)) return [];
  const found: Finding[] = [];
  const add = (rule: Rule, detail: string) => found.push({ rule, file: rel, detail });
  const fence = FENCE_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  if (fence.length > 0 && !isAuthorityFile(rel) && ownerOf(rel, owners) === null)
    add('unowned', `matches ${fence.join(', ')} but has no owner in Appendix A`);
  if (isAuthorityFile(rel)) return found;
  // An OpenAPI `summary:` line is prose ("Set or replace the key"), not SQL.
  if (REPLACE.test(text.replace(/^\s*summary:.*$/gm, '')) && !(rel in REPLACE_ALLOWLIST))
    add('replace', 'OR REPLACE / REPLACE INTO outside the allowlist');
  // Only a WHERE clause compares: `SET updated_at = ?` stamps a timestamp.
  if (UPDATED_AT_PREDICATE.test(text))
    add('updated-at-predicate', 'updated_at = ? in a WHERE clause (a timestamp is not an epoch)');
  // An allowlisted file may hold exactly the reviewed statements: a new one, or a changed one, is a finding.
  const pinned = [...(RAW_WRITE_ALLOWLIST[rel]?.writes ?? [])];
  if (rel in RAW_WRITE_ALLOWLIST)
    for (const detail of opaqueFindings(
      rel,
      uninlinedWriteCalls(text, files && { rel, files }).map((c) => c.slice(c.indexOf(':') + 1)),
      OPAQUE_ALLOWLIST[rel],
      files,
    ))
      add('raw-guarded-write', detail);
  if (rel in RAW_WRITE_ALLOWLIST)
    for (const detail of fragmentFindings(text, files && { rel, files }))
      add('raw-guarded-write', detail);
  for (const id of rawWriteStatements(text, files && { rel, files })) {
    const at = pinned.indexOf(id);
    if (at !== -1) {
      pinned.splice(at, 1);
      continue;
    }
    add(
      'raw-guarded-write',
      rel in RAW_WRITE_ALLOWLIST
        ? `raw write ${id} is not one of the statements reviewed in RAW_WRITE_ALLOWLIST`
        : `raw write to ${id.slice(0, id.indexOf(':'))}`,
    );
  }
  if (!(rel in DYNAMIC_WRITE_ALLOWLIST))
    for (const m of DYNAMIC_WRITE.flatMap((re) => [...text.matchAll(re)]))
      add('dynamic-write', `write target built at runtime: ${m[0].replace(/\s+/g, ' ')}`);
  for (const table of untenantedChecks(text))
    if (!(`${rel}#${table}` in UNTENANTED_CHECK_ALLOWLIST))
      add('untenanted-check', `rawCheck tests a ${table} row with no tenant term: use tenantCheck`);
  if (
    (/authority_grants/.test(text) && /\b(?:org_id|mode)\s*=\s*\?/i.test(text)) ||
    PART_TENANT_BIND.test(text) ||
    (BUILDER_TENANT_KEY.test(text) && !(rel in TENANT_KEY_ALLOWLIST))
  )
    add('request-bound-grant-org', 'a grant statement names an org or mode column');
  return found;
}

/** createJobContext mints the job brand: only queue, cron and workflow entry points may call it. */
const JOB_CONTEXT_SITES = /^src\/worker\/(?:jobs|workflows)\//;
export function scanJobContext(rel: string, text: string): Finding[] {
  if (
    notProduction(rel) ||
    JOB_CONTEXT_SITES.test(rel) ||
    rel === 'src/worker/platform/service-context.ts'
  )
    return [];
  return /\bcreateJobContext\(/.test(text)
    ? [
        {
          rule: 'job-context',
          file: rel,
          detail: 'createJobContext outside queue, cron and workflow code',
        },
      ]
    : [];
}

/**
 * Grant factories under jobs/ mint `system:` grants for work a request triggers (baked-template sync).
 * Importing one from modules/** is an explicit allowlist: factory file -> the only module file allowed.
 */
export const JOB_FACTORY_IMPORTERS: Record<string, string | string[]> = {
  'template-sync': 'src/worker/modules/templates/sync.ts',
  'template-merge': [
    'src/worker/modules/templates/fork-updates-offer.ts',
    'src/worker/modules/templates/fork-updates-write.ts',
  ],
  'developer-sandbox': [
    'src/worker/modules/developer/repo-grants.ts',
    'src/worker/modules/developer/repo-grants-reset.ts',
  ],
  'wallet-first-tap': 'src/worker/modules/wallet-providers/offers-google.ts',
  'webhook-ingress': [
    'src/worker/modules/connections/repo-grants.ts',
    'src/worker/modules/connections/webhooks.ts',
  ],
};

/** Only these may import job-authority.ts (the brand) or the test-only prepare. */
const BRAND_IMPORTERS = new Set([
  'src/worker/platform/service-context.ts',
  'src/worker/platform/authority.ts',
]);
export function scanBrandImport(rel: string, text: string): Finding[] {
  if (notProduction(rel) || BRAND_IMPORTERS.has(rel)) return [];
  const found: Finding[] = [];
  // The factories are checked everywhere in the worker, the wallet module included: it is exempt from the
  // write lint, not from who may mint authority.
  for (const [factory, importer] of Object.entries(JOB_FACTORY_IMPORTERS))
    if (
      rel !== `src/worker/jobs/${factory}.ts` &&
      ![importer].flat().includes(rel) &&
      // `import`, `export ... from` (a re-export) and a dynamic `import()` all name the module the same way.
      new RegExp(`(?:from\\s+|import\\s*\\(\\s*)'(?:[^']*jobs/|\\./)${factory}(?:\\.ts)?'`).test(
        text,
      )
    )
      found.push({
        rule: 'job-authority-import',
        file: rel,
        detail: `imports the ${factory} grant factory; only ${[importer].flat().join(' or ')} may`,
      });
  if (skipFile(rel)) return found;
  if (/from\s+'[^']*job-authority(?:\.ts)?'/.test(text))
    found.push({ rule: 'job-authority-import', file: rel, detail: 'imports job-authority.ts' });
  if (/\bprepareGrantForTest\b/.test(text))
    found.push({ rule: 'job-authority-import', file: rel, detail: 'uses prepareGrantForTest' });
  if (!isAuthorityFile(rel) && /\bnew\s+GrantedStatement\s*\(/.test(text))
    found.push({
      rule: 'forged-statement',
      file: rel,
      detail: 'constructs a GrantedStatement: use the grant builder, Grant.audit or Grant.include',
    });
  if (!isAuthorityFile(rel) && BUILDER_INTERNAL.test(text))
    found.push({
      rule: 'builder-internal',
      file: rel,
      detail:
        'names BUILDER, newGrantedStatement, prepareOf or registerPrepare (platform/authority*.ts only)',
    });
  return found;
}

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* sources(path);
    else if (/\.tsx?$/.test(name)) yield path;
  }
}

/** An allowlist entry must still name a file with a raw guarded write, and the list may not grow. */
export function scanAllowlist(files: ReadonlyMap<string, string>): Finding[] {
  const found: Finding[] = [];
  const listed = Object.keys(RAW_WRITE_ALLOWLIST);
  for (const [rel, entry] of Object.entries(RAW_WRITE_ALLOWLIST)) {
    const actual = rawWriteStatements(files.get(rel) ?? '', { rel, files });
    if (actual.length === 0)
      found.push({
        rule: 'stale-allowlist',
        file: rel,
        detail: 'RAW_WRITE_ALLOWLIST names a file with no raw guarded write: remove the entry',
      });
    else {
      const left = [...actual];
      const gone = entry.writes.filter((id) => {
        const at = left.indexOf(id);
        if (at !== -1) left.splice(at, 1);
        return at === -1;
      });
      if (gone.length > 0)
        found.push({
          rule: 'stale-allowlist',
          file: rel,
          detail: `RAW_WRITE_ALLOWLIST pins statements the file no longer holds (${gone.join(', ')}): update or remove them`,
        });
    }
  }
  if (listed.length > RAW_WRITE_ALLOWLIST_LIMIT)
    found.push({
      rule: 'allowlist-growth',
      file: 'tools/authority-scope-allowlists.ts',
      detail: `RAW_WRITE_ALLOWLIST has ${listed.length} entries, the limit is ${RAW_WRITE_ALLOWLIST_LIMIT}: convert the write to a grant`,
    });
  return found;
}

export function scanTree(markdown: string, files: Iterable<[string, string]>): Finding[] {
  const owners = parseAppendixA(markdown);
  const all = [...files];
  const byPath = new Map(all);
  return [
    ...all.flatMap(([rel, text]) => [
      ...scanFile(rel, text, owners, byPath),
      ...scanJobContext(rel, text),
      ...scanBrandImport(rel, text),
      ...(notProduction(rel) ? [] : scanBans(rel, text)),
    ]),
    ...scanAllowlist(byPath),
  ];
}

if (import.meta.main) {
  const strict = process.argv.includes('--strict');
  const verbose = process.argv.includes('--verbose');
  const files: [string, string][] = [];
  for (const file of sources(join(root, 'src/worker')))
    files.push([relative(root, file), readFileSync(file, 'utf8')]);
  if (process.argv.includes('--pins')) {
    for (const [rel, text] of files)
      if (rel in RAW_WRITE_ALLOWLIST)
        process.stdout.write(
          `${rel} ${rawWriteStatements(text, { rel, files: new Map(files) }).join(' ')}\n`,
        );
    process.exit(0);
  }
  if (process.argv.includes('--opaque')) {
    for (const rel of Object.keys(OPAQUE_ALLOWLIST))
      process.stdout.write(
        `${rel} ${opaqueHash(rel, new Map(files), OPAQUE_ALLOWLIST[rel]?.via)}\n`,
      );
    process.exit(0);
  }
  const findings = scanTree(readFileSync(join(root, DOC), 'utf8'), files);
  const byRule = new Map<Rule, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  const summary = [...byRule].map(([rule, list]) => `${rule}: ${list.length}`).join(', ') || 'none';
  process.stderr.write(`authority-scope (${strict ? 'strict' : 'warn'}): ${summary}\n`);
  if (verbose || strict)
    for (const f of findings) process.stderr.write(`  [${f.rule}] ${f.file}: ${f.detail}\n`);
  if (strict && findings.length > 0) process.exit(1);
}
