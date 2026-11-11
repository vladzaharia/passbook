// Authority-redesign scope check (docs/design/authority-epochs.md sections 1.2, 1.3 and 7.1).
// Every file matching a fence pattern needs one owner in Appendix A, and the new lint rules apply.
// Findings are warnings until WP8 turns on --strict. Run in `npm run check:rules`.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { AUTHORITY_TABLES, GUARDED_TABLES } from '../src/worker/platform/authority-tables.ts';

const root = resolve(import.meta.dirname, '..');
const DOC = 'docs/design/authority-epochs.md';

export type Rule =
  | 'unowned'
  | 'replace'
  | 'raw-guarded-write'
  | 'updated-at-predicate'
  | 'request-bound-grant-org'
  | 'job-context'
  | 'job-authority-import'
  | 'forged-statement';

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
const WRITE = new RegExp(
  `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|REPLACE\\s+INTO|DELETE\\s+FROM)\\s+${SCHEMA}${QUOTE}(${GUARDED})\\b|\\bUPDATE(?:\\s+OR\\s+\\w+)?\\s+${SCHEMA}${QUOTE}(${GUARDED})\\b${QUOTE}\\s+SET\\s+([^;]*?)(?:\\bWHERE\\b|[\`'"]|$)`,
  'gis',
);
/** Columns that may change outside a grant: session idle slide, scanner and key last-use stamps. */
const STAMP_ONLY =
  /^(?:\s*(?:last_seen_at|last_ip_prefix|staff_seen_at|idle_expires_at|last_used_at)\s*=\s*[^,]+,?)+\s*$/is;
/** Files that name `mode` in a builder call on purpose. Each needs the reason. */
const TENANT_KEY_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/scan/repo-scanners.ts':
    'the scanner mode move is the one org-scope write that names its destination mode; the source mode is checked with exactlyOne in the same grant',
};
/** Also `UPDATE OR REPLACE`, which evicts a row through any unique key. */
/** A builder call whose arguments name `org_id` or `mode`: the grant supplies both. */
const BUILDER_TENANT_KEY =
  /\b(?:g|grant)\.(?:update|delete|joined|insertSelect|insertJoined|upsert)\([^;]*?['"]?\b(?:org_id|mode)\b['"]?\s*[:,\]]/s;
/** An `include` part whose SQL compares org_id or mode to a bound value instead of `{org}` and `{mode}`. */
const PART_TENANT_BIND =
  /\b(?:writePart|readPart)\(\s*(['"`])(?:(?!\1)[\s\S])*?\b(?:org_id|mode)\s*=\s*\?/;
const REPLACE = /\bOR\s+REPLACE\b|\bREPLACE\s+INTO\b/i;

/** Reviewed `OR REPLACE` sites (section 1.3). Anything else needs an entry in the design doc first. */
export const REPLACE_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/delivery/repo-devices.ts':
    'push_results: per-outbox result keyed (outbox_id, device_id), holds no authority',
};

/**
 * Files whose remaining raw writes to a guarded table are reviewed and intended. Each needs a reason that
 * names why no grant principal exists or applies. Everything else is a finding (blocking under --strict).
 */
export const RAW_WRITE_ALLOWLIST: Record<string, string> = {
  'src/worker/modules/orgs/repo-branding.ts':
    'branding_dirty_at is volatile bookkeeping for the branding reissue debounce, not an authority column',
  'src/worker/modules/auth/repo-sessions.ts':
    "sign-in creates the session (no principal exists yet); idle slide is on the allowlist; sign-out revokes the caller's own session",
  'src/worker/modules/auth/repo.ts':
    'sign-in finds or creates the user and stamps last login before any principal exists',
  'src/worker/modules/me/repo.ts': 'a user edits their own primary email under their own session',
  'src/worker/modules/orgs/repo.ts':
    'trusted callers without an admin session (fixtures, service tests): setOrgBranding, setOrgStatus, markOrgDeleted, insertOrg. Routes use platform.org.* grants',
  'src/worker/modules/orgs/repo-org-writes.ts':
    'the CAS-only org edit for a trusted caller without authority; tenant edits are org.org.update grants',
  'src/worker/modules/orgs/repo-members.ts':
    'invitation accept (the token is the authority) and the revokeMembership fixture helper; manager writes are org.member.* grants',
  'src/worker/modules/settings/repo.ts':
    'trusted org settings writes without authority (fixtures) and system-scope job values; routes use settings grants',
  'src/worker/modules/users/repo.ts':
    'trusted setStatus for service callers without an admin session; the route uses platform.user.* grants',
  'src/worker/modules/scan/repo-scans.ts':
    "release, fail, quarantine and retention purge of the actor's own server-minted claim row: they run after authority is revoked and only close a claim; a scan takes effect only through scan.* grants",
  'src/worker/modules/scan/repo-act-claim.ts':
    "reopen, quarantine and fail of the actor's own claim generation after a key collision, still fenced by the claim authority predicate; a fresh claim is the org_mode.scan.claim upsert",
  'src/worker/modules/scan/repo-gate-recovery.ts':
    'server-side recovery of a crashed claim: quarantines the claim and restores only gate and presence snapshots that still match what the crashed scan wrote; it runs from the recovery job (or once per collision) and takes no actor authority',
  'src/worker/modules/scan/repo-scans-write.ts':
    'claim, finalize and ledger statements kept for fixtures and the reconcile tests; production writes are scan.* grants',
  'src/worker/modules/scan/repo-counts.ts':
    'scan_events.expected is an idempotent cache fill on a GET (volatile, derived from the guarded event config_epoch); it is not authority',
  'src/worker/modules/events/repo.ts':
    'pass_events is an append-only ledger written by recordPassEvent; WP5b owns the grant conversion',
  'src/worker/modules/apple/repo-events.ts':
    'device.fetched ledger rows from the Apple device protocol, fenced in SQL by the credential serial and generation; the device principal has no ledger purpose',
  'src/worker/modules/passes/repo-remove-compensate.ts':
    "exact-state compensation of this request's own removal claim (must run after authority is revoked) and claims for trusted callers without tenant authority; routes take the grants in repo-remove.ts",
  'src/worker/modules/passes/repo-pass-trusted.ts':
    'link rotation, refresh claim and soft delete for callers with no tenant authority (holder refresh, fixtures, service tests); tenant requests take repo-pass-grants.ts',
  'src/worker/modules/passes/repo-connection-state.ts':
    'sync_error_code is volatile bookkeeping stamped by connection sync behind a full pass and release snapshot',
  'src/worker/modules/passes/repo-history-assets.ts':
    'exact-state rollback of an asset write after a failed rebuild, and trusted callers; tenant writes take replaceAssetGranted',
  'src/worker/modules/passes/repo-history-image.ts':
    'commitImageMutation advances link_generation only for the exact-state rollback paths of asset and member photo writes and trusted callers; tenant writes take replaceAssetGranted and replaceMemberPhotoGranted',
  'src/worker/modules/passes/repo-member-photo.ts':
    "exact-state compensation of this request's own photo write (after authority may be revoked) and trusted callers; tenant writes take replaceMemberPhotoGranted",
  'src/worker/modules/passes/repo-ops-retention.ts':
    'retention purge of a soft-deleted pass past its grace period: server-selected ids behind a keyset commitment and scan retention proof, no principal',
  'src/worker/modules/passes/repo-transfer-asset-gc.ts':
    'GC of retired transfer asset keys: lifecycle bookkeeping on server-minted r2 keys, no principal',
  'src/worker/modules/passes/repo-transfer-asset-retirement.ts':
    'statements joined into the transfer-finish batch after its CAS guards; authority is the finish grant, which the transfers owner converts to g.delete',
  'src/worker/modules/delivery/repo-outbox-processing.ts':
    'outbox lease, retry and finish bookkeeping for a row already authorized at queue time; the provider boundary is a grant (repo-provider-attempt.ts)',
  'src/worker/modules/delivery/repo-binding.ts':
    'outbox lease check, provider acceptance and uncertain-outcome settlement for a leased row; no principal acts on it',
  'src/worker/modules/delivery/repo-devices.ts':
    'push device outcomes (outbox cancel, pass_events) written while delivering a leased push',
  'src/worker/modules/delivery/repo-issuance-recovery.ts':
    'issuance delivery retry deferral and stale cancellation by the scheduler; cancelling cannot widen authority',
  'src/worker/modules/sandbox/repo.ts':
    'daily test-data retention purge (captured_emails, bundles); a platform job with no tenant principal',
};

const skipFile = (rel: string) =>
  !/\.tsx?$/.test(rel) ||
  /\.test\.tsx?$/.test(rel) ||
  /(?:fixtures?|test-kit|test-support|test-helpers?|testing)[a-z0-9-]*\.tsx?$/.test(rel) ||
  rel.startsWith('src/worker/modules/wallet-providers/') ||
  !rel.startsWith('src/worker/');

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

export function scanFile(rel: string, text: string, owners: Owners): Finding[] {
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
  if (
    /updated_at\s*=\s*\?/.test(text) &&
    /\b(?:UPDATE|WHERE|AND)\b[^;]*updated_at\s*=\s*\?/is.test(text)
  )
    add('updated-at-predicate', 'updated_at = ? (a timestamp is not an epoch)');
  for (const m of rel in RAW_WRITE_ALLOWLIST ? [] : text.matchAll(WRITE)) {
    const table = m[1] ?? m[2];
    if (m[2] && STAMP_ONLY.test(m[3] ?? '')) continue;
    add('raw-guarded-write', `raw write to ${table}`);
  }
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
    skipFile(rel) ||
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
  if (skipFile(rel) || BRAND_IMPORTERS.has(rel)) return [];
  const found: Finding[] = [];
  if (/from\s+'[^']*job-authority(?:\.ts)?'/.test(text))
    found.push({ rule: 'job-authority-import', file: rel, detail: 'imports job-authority.ts' });
  if (/\bprepareGrantForTest\b/.test(text))
    found.push({ rule: 'job-authority-import', file: rel, detail: 'uses prepareGrantForTest' });
  for (const [factory, importer] of Object.entries(JOB_FACTORY_IMPORTERS))
    if (
      rel.startsWith('src/worker/modules/') &&
      ![importer].flat().includes(rel) &&
      new RegExp(`from\\s+'[^']*jobs/${factory}(?:\\.ts)?'`).test(text)
    )
      found.push({
        rule: 'job-authority-import',
        file: rel,
        detail: `imports the ${factory} grant factory; only ${[importer].flat().join(' or ')} may`,
      });
  if (!isAuthorityFile(rel) && /\bnew\s+GrantedStatement\s*\(/.test(text))
    found.push({
      rule: 'forged-statement',
      file: rel,
      detail: 'constructs a GrantedStatement: use the grant builder, Grant.audit or Grant.include',
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

export function scanTree(markdown: string, files: Iterable<[string, string]>): Finding[] {
  const owners = parseAppendixA(markdown);
  return [...files].flatMap(([rel, text]) => [
    ...scanFile(rel, text, owners),
    ...scanJobContext(rel, text),
    ...scanBrandImport(rel, text),
  ]);
}

if (import.meta.main) {
  const strict = process.argv.includes('--strict');
  const verbose = process.argv.includes('--verbose');
  const files: [string, string][] = [];
  for (const file of sources(join(root, 'src/worker')))
    files.push([relative(root, file), readFileSync(file, 'utf8')]);
  const findings = scanTree(readFileSync(join(root, DOC), 'utf8'), files);
  const byRule = new Map<Rule, Finding[]>();
  for (const f of findings) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f]);
  const summary = [...byRule].map(([rule, list]) => `${rule}: ${list.length}`).join(', ') || 'none';
  process.stderr.write(`authority-scope (${strict ? 'strict' : 'warn'}): ${summary}\n`);
  if (verbose || strict)
    for (const f of findings) process.stderr.write(`  [${f.rule}] ${f.file}: ${f.detail}\n`);
  if (strict && findings.length > 0) process.exit(1);
}
