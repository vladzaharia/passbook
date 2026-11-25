// biome-ignore-all lint/suspicious/noTemplateCurlyInString: SQL and source text matched as strings
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DYNAMIC_WRITE_ALLOWLIST,
  expandBraces,
  ownerOf,
  parseAppendixA,
  RAW_WRITE_ALLOWLIST,
  RAW_WRITE_ALLOWLIST_LIMIT,
  rawWriteStatements,
  scanAllowlist,
  scanBrandImport,
  scanFile,
  scanJobContext,
  scanTree,
  UNTENANTED_CHECK_ALLOWLIST,
  uninlinedWriteCalls,
  untenantedChecks,
} from './authority-scope.ts';
import { scanBans } from './authority-scope-bans.ts';

const doc = readFileSync(new URL('../docs/design/authority-epochs.md', import.meta.url), 'utf8');
const owners = parseAppendixA(doc);
const MOD = 'src/worker/modules';

describe('authority-scope', () => {
  it('expands braces and resolves Appendix A owners', () => {
    expect(expandBraces('a/{b,c}.ts')).toEqual(['a/b.ts', 'a/c.ts']);
    expect(ownerOf(`${MOD}/api-keys/repo.ts`, owners)).toBe('WP1');
    expect(ownerOf(`${MOD}/scan/repo-undo-target.ts`, owners)).toBe('WP6');
    expect(ownerOf(`${MOD}/scan/guard.ts`, owners)).toBe('WP5a');
    expect(ownerOf(`${MOD}/templates/repo-releases.ts`, owners)).toBe('WP-T');
    expect(ownerOf('src/web/scan/api/to-fail.ts', owners)).toBe('WP5b');
    expect(ownerOf(`${MOD}/billing/repo.ts`, owners)).toBeNull();
  });

  it('fails a fence match that has no owner, and passes an owned one', () => {
    const text = 'const sql = "SELECT 1 WHERE o.updated_at = ?";';
    expect(scanFile(`${MOD}/billing/repo.ts`, text, owners).map((f) => f.rule)).toContain(
      'unowned',
    );
    expect(scanFile(`${MOD}/settings/repo.ts`, text, owners).map((f) => f.rule)).not.toContain(
      'unowned',
    );
    for (const text of [
      'x.changes()',
      'credentialRefKeysetSql',
      'platformAdminSessionSql',
      'noScopedReleaseSql',
      'tenantPassWriteSql',
    ])
      expect(
        scanFile(`${MOD}/billing/repo.ts`, text, owners).map((f) => f.rule),
        text,
      ).toContain('unowned');
  });

  it('flags OR REPLACE outside the reviewed allowlist', () => {
    const text = 'run(db, "INSERT OR REPLACE INTO push_results (a) VALUES (?)")';
    expect(scanFile(`${MOD}/delivery/repo-devices.ts`, text, owners)).toEqual([]);
    expect(scanFile(`${MOD}/delivery/repo-other.ts`, text, owners).map((f) => f.rule)).toEqual([
      'replace',
    ]);
    expect(scanFile(`${MOD}/x/repo.ts`, 'REPLACE INTO t', owners).map((f) => f.rule)).toEqual([
      'replace',
    ]);
    // UPDATE OR REPLACE evicts a row through any unique key, too.
    for (const text of [
      'run(db, "UPDATE OR REPLACE x SET a = ?")',
      'run(db, "update or  replace x SET a = ?")',
    ])
      expect(scanFile(`${MOD}/x/repo.ts`, text, owners).map((f) => f.rule)).toEqual(['replace']);
  });

  it('flags raw writes to the authority tables', () => {
    for (const table of ['authority_grants', 'retired_api_key_ids'])
      expect(
        scanFile(`${MOD}/x/repo.ts`, `run(db, "DELETE FROM ${table} WHERE id = ?")`, owners).map(
          (f) => f.rule,
        ),
      ).toContain('raw-guarded-write');
  });

  it('flags a raw write to a credential check, from the wallet module too: only the check job writes one', () => {
    for (const rel of [`${MOD}/x/repo.ts`, `${MOD}/wallet-providers/repo-accounts.ts`])
      for (const text of [
        'run(db, "INSERT INTO wallet_credential_checks (id, ok) VALUES (?, 1)")',
        'run(db, "INSERT OR IGNORE INTO wallet_credential_checks (id, ok) VALUES (?, 1)")',
        'run(db, "DELETE FROM wallet_credential_checks WHERE id = ?")',
        'run(db, "UPDATE wallet_credential_checks SET ok = 1 WHERE id = ?")',
        'run(db, "INSERT INTO wallet_credentials (id) VALUES (?)")',
        'run(db, "UPDATE wallet_enrolment_events SET kind = ? WHERE id = ?")',
      ])
        expect(
          scanFile(rel, text, owners).map((f) => f.rule),
          text,
        ).toEqual(['raw-guarded-write']);
    // The account row stays outside the deny list: it is written by include parts and the wallet repo.
    expect(
      scanFile(
        `${MOD}/x/repo.ts`,
        'run(db, "UPDATE wallet_provider_accounts SET enabled_at = ?")',
        owners,
      ),
    ).toEqual([]);
  });

  it('flags raw writes to guarded tables but not stamps, reads, tests or authority.ts', () => {
    const file = `${MOD}/x/repo.ts`;
    const rules = (text: string, rel = file) => scanFile(rel, text, owners).map((f) => f.rule);
    expect(rules('run(db, "UPDATE passes SET status = ? WHERE id = ?")')).toEqual([
      'raw-guarded-write',
    ]);
    expect(rules('run(db, "INSERT INTO scans (id) VALUES (?)")')).toEqual(['raw-guarded-write']);
    expect(rules('run(db, "DELETE FROM outbox WHERE id = ?")')).toEqual(['raw-guarded-write']);
    expect(
      rules(
        'run(db, "UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id_hash = ?")',
      ),
    ).toEqual([]);
    expect(rules('run(db, "UPDATE sessions SET revoked_at = ? WHERE id_hash = ?")')).toEqual([
      'raw-guarded-write',
    ]);
    expect(rules('all(db, "SELECT * FROM passes WHERE id = ?")')).toEqual([]);
    expect(rules('run(db, "UPDATE wallet_provider_accounts SET a = ?")')).toEqual([]);
    expect(rules('run(db, "UPDATE passes SET status = ?")', `${MOD}/x/thing.test.ts`)).toEqual([]);
    expect(rules('run(db, "UPDATE passes SET a = ?")', `${MOD}/wallet-providers/repo.ts`)).toEqual(
      [],
    );
    expect(
      rules('db.prepare("UPDATE passes SET a = ?")', 'src/worker/platform/authority.ts'),
    ).toEqual([]);
    expect(
      rules('db.prepare("UPDATE passes SET a = ?")', 'src/worker/platform/authority-statements.ts'),
    ).toEqual([]);
  });

  it('flags updated_at used as a predicate, not as an assignment', () => {
    const rel = `${MOD}/settings/repo.ts`;
    expect(
      scanFile(rel, 'x WHERE org_id = ? AND o.updated_at = ?', owners).map((f) => f.rule),
    ).toEqual(['updated-at-predicate']);
    expect(scanFile(rel, 'SET name = ?, updated_at = ? WHERE id = ?', owners)).toEqual([]);
    expect(scanFile(rel, 'INSERT INTO t (id, updated_at) SELECT ?, ?', owners)).toEqual([]);
    // A WHERE in one literal does not reach an assignment in the next.
    expect(
      scanFile(
        rel,
        "run('SELECT 1 WHERE id = ?', [a]); run(`UPDATE t SET updated_at = ?`)",
        owners,
      ),
    ).toEqual([]);
  });

  it('blocks a stale or additional raw-write allowlist entry', () => {
    const rel = Object.keys(RAW_WRITE_ALLOWLIST)[0] ?? '';
    const files = new Map(treeFiles());
    expect(scanAllowlist(files)).toEqual([]);
    expect(
      scanAllowlist(new Map(files).set(rel, 'export const x = 1;')).map((f) => f.rule),
    ).toEqual(['stale-allowlist']);
    expect(Object.keys(RAW_WRITE_ALLOWLIST).length).toBeLessThanOrEqual(RAW_WRITE_ALLOWLIST_LIMIT);
  });

  it('pins each raw statement of an allowlisted file by its fingerprint', () => {
    const rel = 'src/worker/modules/auth/repo-sessions.ts';
    const text = new Map(treeFiles()).get(rel) ?? '';
    const rawFindings = (source: string) =>
      scanFile(rel, source, owners).filter((f) => f.rule === 'raw-guarded-write');
    expect(rawFindings(text)).toEqual([]);
    // Reformatting keeps the pin; a changed WHERE (one reviewed statement widened) does not.
    expect(rawFindings(text.replace(/\n\s+/g, '\n      '))).toEqual([]);
    const widened = text.replace(
      'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?',
      'UPDATE sessions SET revoked_at = ? WHERE id_hash = ? OR user_id IS NOT NULL',
    );
    expect(widened).not.toBe(text);
    expect(rawFindings(widened)).toHaveLength(1);
    // A swapped statement on the same table, and an extra one, are findings too.
    expect(
      rawFindings(`${text}\nrun(db, 'UPDATE sessions SET csrf_secret = ?', [1]);`),
    ).toHaveLength(1);
    expect(
      rawFindings(`${text}\nrun(db, 'DELETE FROM passes WHERE id = ?', [1]);`)[0]?.detail,
    ).toContain('passes:');
    // A statement that is only in a comment is not a statement.
    const commented = `${text}\n// run(db, 'DELETE FROM sessions WHERE 1 = 1');\n/* UPDATE sessions SET x = 1 */`;
    expect(rawFindings(commented)).toEqual([]);
    expect(rawWriteStatements(commented)).toEqual(rawWriteStatements(text));
    // A URL in a string is not a comment start.
    const url = "const u = 'https://example.test'; run(db, 'DELETE FROM sessions WHERE a = ?');";
    expect(rawWriteStatements(url)).toHaveLength(1);
  });

  it('pins the predicate behind an interpolation, so a changed constant fails', () => {
    const rel = 'src/worker/modules/scan/repo-gate-recovery.ts';
    const text = new Map(treeFiles()).get(rel) ?? '';
    const rawFindings = (source: string) =>
      scanFile(rel, source, owners).filter((f) => f.rule === 'raw-guarded-write');
    expect(rawFindings(text)).toEqual([]);
    const widened = text.replace('pass_id = ? AND action_id = ?', 'pass_id = ? OR action_id = ?');
    expect(widened).not.toBe(text);
    // `${match}` is a same-file constant: its value is part of both statements that use it.
    expect(rawFindings(widened)).toHaveLength(2);
    // Other interpolations keep their expression text.
    const interp = (e: string) => `run(db, \`DELETE FROM sessions WHERE $\{${e}}\`)`;
    expect(rawWriteStatements(interp('a'))).not.toEqual(rawWriteStatements(interp('b')));
    expect(rawWriteStatements(interp(' a '))).toEqual(rawWriteStatements(interp('a')));
  });

  it('pins the connection write through the imported predicate constant', () => {
    const rel = 'src/worker/modules/passes/repo-connection-state.ts';
    const ctx = 'src/worker/modules/passes/repo-connection-context.ts';
    const files = new Map(treeFiles());
    const findings = (map: Map<string, string>) =>
      scanFile(rel, map.get(rel) ?? '', owners, map).filter((f) => f.rule === 'raw-guarded-write');
    expect(findings(files)).toEqual([]);
    const source = files.get(ctx) ?? '';
    expect(source).toContain('const connectionPassPredicate = `org_id = ? AND mode = ?');
    const dropped = new Map(files).set(
      ctx,
      source.replace('`org_id = ? AND mode = ?', '`mode = ?'),
    );
    expect(findings(dropped)).not.toEqual([]);
  });

  it('pins the claimRefresh connection fence, so dropping a term from it fails', () => {
    const rel = 'src/worker/modules/passes/repo-pass-trusted.ts';
    const snap = 'src/worker/modules/passes/repo-refresh-snapshot.ts';
    const files = new Map(treeFiles());
    const findings = (map: Map<string, string>) =>
      scanFile(rel, map.get(rel) ?? '', owners, map).filter((f) => f.rule === 'raw-guarded-write');
    expect(findings(files)).toEqual([]);
    const source = files.get(snap) ?? '';
    for (const term of ['AND c.org_id = passes.org_id', "AND mode = 'live'"]) {
      expect(source).toContain(term);
      expect(findings(new Map(files).set(snap, source.replace(term, '')))).not.toEqual([]);
    }
  });

  it('fails an interpolation the pin cannot see into, unless reviewed', () => {
    const rel = 'src/worker/modules/passes/repo-connection-state.ts';
    const ctx = 'src/worker/modules/passes/repo-connection-context.ts';
    const files = new Map(treeFiles());
    const text = files.get(rel) ?? '';
    const findings = (map: Map<string, string>, source: string) =>
      scanFile(rel, source, owners, map).filter((f) => f.rule === 'raw-guarded-write');
    // The reviewer's probe: strip the org term out of the constant before it is interpolated.
    const probe = text
      .replace('${connectionPassPredicate}${fences ?', '${pred}${fences ?')
      .replace(
        'const fences =',
        'const pred = connectionPassPredicate.replace("org_id = ? AND ", "");\n  const fences =',
      );
    expect(probe).not.toBe(text);
    expect(findings(files, probe).some((f) => f.detail.includes('${pred}'))).toBe(true);
    // A reviewed interpolation is pinned to the source behind it: editing a dependency fails.
    const edited = new Map(files).set(
      ctx,
      `${files.get(ctx) ?? ''}\n// not a comment-only change: x`,
    );
    expect(findings(edited, text)).toEqual([]);
    const changed = new Map(files).set(ctx, `${files.get(ctx) ?? ''}\nexport const extra = 1;`);
    expect(findings(changed, text).some((f) => f.detail.includes('source behind'))).toBe(true);
  });

  it('fails when the source of a caller-built fragment gains an OR', () => {
    const files = new Map(treeFiles());
    const mod = 'src/worker/modules/';
    const cases: [string, string, string, string][] = [
      [
        `${mod}passes/repo-connection-state.ts`,
        `${mod}passes/repo-release.ts`,
        'sql: `',
        'sql: `1 OR ',
      ],
      [
        `${mod}events/repo.ts`,
        `${mod}wallet-providers/repo-holder-events.ts`,
        'WHERE id = ?)',
        'WHERE id = ?) OR 1',
      ],
    ];
    for (const [rel, dep, from, to] of cases) {
      const findings = (map: Map<string, string>) =>
        scanFile(rel, map.get(rel) ?? '', owners, map).filter(
          (f) => f.rule === 'raw-guarded-write',
        );
      expect(findings(files)).toEqual([]);
      const source = files.get(dep) ?? '';
      expect(source).toContain(from);
      const changed = new Map(files).set(dep, source.replaceAll(from, to));
      expect(findings(changed).some((f) => f.detail.includes('source behind'))).toBe(true);
    }
  });

  it('inlines a ternary of literals, and a constant that is one', () => {
    const same = (a: string, b: string) =>
      expect(rawWriteStatements(a)).toEqual(rawWriteStatements(b));
    const base = (cond: string) =>
      `run(db, \`DELETE FROM sessions WHERE id = ?$\{x ? ' AND ${cond}' : ''}\`)`;
    same(base('a = ?'), base('a = ?'));
    expect(rawWriteStatements(base('a = ?'))).not.toEqual(rawWriteStatements(base('a = 1')));
    const held = (cond: string) =>
      `const held = x ? ' AND ${cond}' : '';\nrun(db, \`DELETE FROM sessions WHERE id = ?$\{held}\`)`;
    expect(uninlinedWriteCalls(held('a = ?'))).toEqual([]);
    expect(rawWriteStatements(held('a = ?'))).not.toEqual(rawWriteStatements(held('a = 1')));
  });

  it('fails a pinned statement that calls a function the pin cannot see into', () => {
    const rel = 'src/worker/modules/auth/repo-sessions.ts';
    const text = new Map(treeFiles()).get(rel) ?? '';
    expect(uninlinedWriteCalls(text)).toEqual([]);
    const called = `${text}\nrun(db, \`DELETE FROM sessions WHERE id = ? AND ($\{scopeSql(x)})\`, []);`;
    expect(uninlinedWriteCalls(called)).toEqual(['sessions:scopeSql(x)']);
    expect(
      scanFile(rel, called, owners).filter((f) => f.detail.includes('scopeSql(x)')),
    ).toHaveLength(1);
  });

  it('pins a concatenated tail and a constant run from a new call site', () => {
    const base = "run(db, 'DELETE FROM sessions WHERE ' + cond, []);";
    expect(rawWriteStatements(base)).toHaveLength(1);
    expect(rawWriteStatements(base)).not.toEqual(
      rawWriteStatements("run(db, 'DELETE FROM sessions WHERE ' + other, []);"),
    );
    expect(
      rawWriteStatements("run(db, 'DELETE FROM sessions WHERE ' + 'id = ?', []);"),
    ).not.toEqual(rawWriteStatements("run(db, 'DELETE FROM sessions WHERE ' + 'id > ?', []);"));
    const once = "const Q = 'DELETE FROM sessions WHERE id = ?';\nrun(db, Q, [id]);";
    const twice = `${once}\nrun(db, Q, [other]);`;
    expect(rawWriteStatements(once)).toHaveLength(2);
    expect(rawWriteStatements(twice)).toHaveLength(3);
    const rel = 'src/worker/modules/auth/repo-sessions.ts';
    const text = new Map(treeFiles()).get(rel) ?? '';
    expect(
      scanFile(rel, `${text}\n${twice}`, owners).filter((f) => f.rule === 'raw-guarded-write'),
    ).not.toHaveLength(0);
  });

  it('resolves an imported constant, so changing its definition fails the importer pin', () => {
    const rel = `${MOD}/passes/repo-pass-trusted.ts`;
    const files = new Map(treeFiles());
    const text = files.get(rel) ?? '';
    const rawFindings = (map: ReadonlyMap<string, string>) =>
      scanFile(rel, text, owners, map).filter((f) => f.rule === 'raw-guarded-write');
    expect(rawFindings(files)).toEqual([]);
    const definition = [...files].find(([, t]) => /export const BUNDLE_RESERVED\b/.test(t));
    if (!definition) throw new Error('BUNDLE_RESERVED is not exported in the tree.');
    const changed = new Map(files).set(
      definition[0],
      definition[1].replace(/(export const BUNDLE_RESERVED[^`'"]*[`'"])/, '$1 1 = 1 OR '),
    );
    expect(changed.get(definition[0])).not.toBe(definition[1]);
    expect(rawFindings(changed).length).toBeGreaterThan(0);
  });

  it('counts each use of an exported pinned write in another file, and survives import cycles', () => {
    const exporter = "export const PURGE = 'DELETE FROM sessions WHERE id = ?';";
    const user = "import { PURGE } from './a.ts';\nrun(db, PURGE, [id]);\nrun(db, PURGE, [other]);";
    const files = new Map([
      [`${MOD}/x/a.ts`, exporter],
      [`${MOD}/x/b.ts`, user],
    ]);
    const used = rawWriteStatements(user, { rel: `${MOD}/x/b.ts`, files });
    expect(used).toHaveLength(2);
    expect(used.every((id) => id.endsWith('@use'))).toBe(true);
    expect(rawWriteStatements(user)).toEqual([]);
    // A new file that runs the write is flagged; its own `run(db, PURGE)` is not a write literal.
    expect(
      scanFile(`${MOD}/x/b.ts`, user, owners, files).filter((f) => f.rule === 'raw-guarded-write'),
    ).toHaveLength(2);
    // Constants that name each other do not loop.
    const ref = (name: string) => `$\{${name}}`;
    const cyc = new Map([
      [`${MOD}/x/c.ts`, `import { B } from './d.ts';\nexport const A = \`a ${ref('B')}\`;`],
      [`${MOD}/x/d.ts`, `import { A } from './c.ts';\nexport const B = \`b ${ref('A')}\`;`],
    ]);
    const source = `import { A } from './c.ts';\nrun(db, \`DELETE FROM sessions WHERE ${ref('A')}\`);`;
    expect(rawWriteStatements(source, { rel: `${MOD}/x/e.ts`, files: cyc })).toHaveLength(1);
  });

  it('flags a pin whose statement is gone, even when a comment still names it', () => {
    const rel = 'src/worker/modules/auth/repo-sessions.ts';
    const files = new Map(treeFiles());
    const text = files.get(rel) ?? '';
    const gone = text.replace(
      'UPDATE sessions SET revoked_at = ? WHERE id_hash = ?',
      'SELECT 1 FROM sessions WHERE id_hash = ?',
    );
    expect(gone).not.toBe(text);
    const padded = `${gone}\n// UPDATE sessions SET revoked_at = ? WHERE id_hash = ?`;
    expect(scanAllowlist(new Map(files).set(rel, padded)).map((f) => f.rule)).toEqual([
      'stale-allowlist',
    ]);
  });

  it('every pin equals the raw guarded statements in the tree', () => {
    const text = new Map(treeFiles());
    for (const [rel, entry] of Object.entries(RAW_WRITE_ALLOWLIST))
      expect(rawWriteStatements(text.get(rel) ?? '', { rel, files: text }), rel).toEqual(
        [...entry.writes].sort(),
      );
  });

  it('flags a grant statement that binds an org or mode from the request', () => {
    const rel = `${MOD}/x/service.ts`;
    const bad = 'INSERT INTO authority_grants (id) SELECT ? FROM orgs WHERE org_id = ?';
    expect(scanFile(rel, bad, owners).map((f) => f.rule)).toContain('request-bound-grant-org');
    expect(scanFile(rel, 'SELECT 1 FROM authority_grants g WHERE g.id = ?', owners)).toEqual([]);
    expect(scanFile('src/worker/platform/authority.ts', bad, owners)).toEqual([]);
  });

  it('flags an include write part that binds an org or mode from the request', () => {
    const rel = `${MOD}/x/repo.ts`;
    const bad =
      "g.include(writePart('INSERT INTO counters (org_id) SELECT 1 WHERE {grant} AND org_id = ?', [o]))";
    expect(scanFile(rel, bad, owners).map((f) => f.rule)).toContain('request-bound-grant-org');
    const ok = "g.include(writePart('INSERT INTO counters (key) SELECT 1 WHERE {grant}', []))";
    expect(scanFile(rel, ok, owners)).toEqual([]);
    expect(scanBrandImport(rel, ok)).toEqual([]);
  });

  it('flags a builder call that names the org or mode column', () => {
    const rel = `${MOD}/x/service.ts`;
    for (const text of [
      "g.update('passes', { set: { status: 'x' }, where: { org_id: orgId } });",
      "g.delete('scans', { where: { mode: 'test' } });",
      "grant.insertSelect('scans', ['org_id', 'id'], [o, i]);",
    ])
      expect(
        scanFile(rel, text, owners).map((f) => f.rule),
        text,
      ).toEqual(['request-bound-grant-org']);
    expect(
      scanFile(rel, "g.update('passes', { set: { status: 'x' }, where: { id } });", owners),
    ).toEqual([]);
  });

  it('flags importers of the job brand and the test-only prepare', () => {
    const imp = "import { withJobAuthority } from '../platform/job-authority.ts';";
    expect(scanBrandImport(`${MOD}/x/routes.ts`, imp).map((f) => f.rule)).toEqual([
      'job-authority-import',
    ]);
    expect(scanBrandImport(`${MOD}/x/routes.ts`, 'prepareGrantForTest(g)')).toHaveLength(1);
    const factory = "import { templateSyncGrant } from '../../jobs/template-sync.ts';";
    expect(scanBrandImport(`${MOD}/x/routes.ts`, factory)).toHaveLength(1);
    expect(scanBrandImport(`${MOD}/templates/sync.ts`, factory)).toEqual([]);
    const ingress = "import { webhookIngressGrant } from '../../jobs/webhook-ingress.ts';";
    expect(scanBrandImport(`${MOD}/x/routes.ts`, ingress)).toHaveLength(1);
    // The first-tap factory: only offers-google.ts, and the wallet module is not exempt from the rule.
    const firstTap = "import { runFirstTapUpsert } from '../../jobs/wallet-first-tap.ts';";
    expect(scanBrandImport(`${MOD}/wallet-providers/offers-google.ts`, firstTap)).toEqual([]);
    expect(scanBrandImport(`${MOD}/wallet-providers/offers.ts`, firstTap)).toHaveLength(1);
    expect(scanBrandImport(`${MOD}/passes/routes.ts`, firstTap)).toHaveLength(1);
    expect(scanBrandImport('src/worker/routes/x.ts', firstTap)).toHaveLength(1);
    // A re-export, from jobs/ too, and a dynamic import are the same import.
    const reexport = "export { runFirstTapUpsert } from './wallet-first-tap.ts';";
    expect(scanBrandImport('src/worker/jobs/relay.ts', reexport)).toHaveLength(1);
    expect(scanBrandImport(`${MOD}/passes/relay.ts`, reexport)).toHaveLength(1);
    const dynamic = "const m = await import('../../jobs/wallet-first-tap.ts');";
    expect(scanBrandImport(`${MOD}/passes/routes.ts`, dynamic)).toHaveLength(1);
    expect(scanBrandImport(`${MOD}/wallet-providers/offers-google.ts`, dynamic)).toEqual([]);
    expect(scanBrandImport('src/worker/jobs/wallet-first-tap.ts', reexport)).toEqual([]);
    expect(scanBrandImport(`${MOD}/connections/routes.ts`, ingress)).toHaveLength(1);
    expect(scanBrandImport(`${MOD}/connections/repo-grants.ts`, ingress)).toEqual([]);
    expect(scanBrandImport(`${MOD}/connections/webhooks.ts`, ingress)).toEqual([]);
    expect(scanBrandImport('src/worker/platform/service-context.ts', imp)).toEqual([]);
    expect(scanBrandImport('src/worker/platform/authority.ts', imp)).toEqual([]);
    expect(scanBrandImport(`${MOD}/x/routes.test.ts`, imp)).toEqual([]);
  });

  it('suppresses raw guarded writes only in reviewed files, and ignores summary prose for REPLACE', () => {
    const write = 'run(db, "UPDATE users SET status = ? WHERE id = ?")';
    const reviewed = new Map(treeFiles()).get(`${MOD}/users/repo.ts`) ?? '';
    expect(scanFile(`${MOD}/users/repo.ts`, reviewed, owners).map((f) => f.rule)).toEqual([]);
    // A reviewed file pins its statements: an unreviewed one in it is a finding too.
    expect(scanFile(`${MOD}/users/repo.ts`, write, owners).map((f) => f.rule)).toEqual([
      'raw-guarded-write',
    ]);
    expect(scanFile(`${MOD}/users/other.ts`, write, owners).map((f) => f.rule)).toContain(
      'raw-guarded-write',
    );
    expect(scanFile(`${MOD}/x/routes.ts`, "summary: 'Set or replace the key',", owners)).toEqual(
      [],
    );
  });

  it('flags a module that constructs a GrantedStatement', () => {
    const text = 'g.add(new GrantedStatement(g.id, { sql, params }));';
    expect(scanBrandImport(`${MOD}/x/repo.ts`, text).map((f) => f.rule)).toEqual([
      'forged-statement',
    ]);
    expect(scanBrandImport('src/worker/platform/authority.ts', text)).toEqual([]);
    expect(scanBrandImport(`${MOD}/x/repo.ts`, 'g.unguarded(sql, params)')).toEqual([]);
  });

  it('flags createJobContext outside job entry points', () => {
    const text = "const ctx = createJobContext(env, 'x');";
    expect(scanJobContext(`${MOD}/passes/routes.ts`, text).map((f) => f.rule)).toEqual([
      'job-context',
    ]);
    expect(scanJobContext('src/worker/jobs/queue.ts', text)).toEqual([]);
    expect(scanJobContext('src/worker/workflows/broadcast.ts', text)).toEqual([]);
  });

  it('the repository has no finding of any rule (check:rules runs --strict)', () => {
    expect(scanTree(doc, treeFiles())).toEqual([]);
  });

  it('every allowlist entry still matches the tree', () => {
    const files = treeFiles();
    const text = new Map(files);
    for (const rel of Object.keys(RAW_WRITE_ALLOWLIST))
      expect(
        scanFile(rel, text.get(rel) ?? '', { exact: new Map([[rel, 'x']]), globs: [] }).length +
          [
            ...(text.get(rel) ?? '').matchAll(
              /\b(?:INSERT|UPDATE|DELETE|REPLACE|deleteInBatches)\b/g,
            ),
          ].length,
        rel,
      ).toBeGreaterThan(0);
    const untenanted = new Set(
      files.flatMap(([rel, t]) => untenantedChecks(t).map((table) => `${rel}#${table}`)),
    );
    for (const key of Object.keys(UNTENANTED_CHECK_ALLOWLIST))
      expect(untenanted.has(key), key).toBe(true);
    for (const rel of Object.keys(DYNAMIC_WRITE_ALLOWLIST)) expect(text.has(rel), rel).toBe(true);
  });
});

function treeFiles(): [string, string][] {
  const root = new URL('..', import.meta.url).pathname;
  const files: [string, string][] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(`${root}${dir}`)) {
      const rel = `${dir}/${name}`;
      if (statSync(`${root}${rel}`).isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(name)) files.push([rel, readFileSync(`${root}${rel}`, 'utf8')]);
    }
  };
  walk('src/worker');
  return files;
}

describe('authority-scope write targets', () => {
  it('flags schema-qualified, quoted and REPLACE INTO writes to a guarded table', () => {
    const rel = `${MOD}/x/repo.ts`;
    for (const sql of [
      "UPDATE main.passes SET display_title = 'x' WHERE id = ?",
      'UPDATE "passes" SET display_title = ? WHERE id = ?',
      'REPLACE INTO passes (id) VALUES (?)',
      'DELETE FROM main.passes WHERE id = ?',
      'INSERT OR REPLACE INTO main.passes (id) VALUES (?)',
    ])
      expect(
        scanFile(rel, sql, owners).map((f) => f.rule),
        sql,
      ).toContain('raw-guarded-write');
  });
});

describe('authority-scope write forms', () => {
  const rel = `${MOD}/x/repo.ts`;
  const rules = (text: string, file = rel) => scanFile(file, text, owners).map((f) => f.rule);

  it('flags aliased, indexed and unindexed updates and aliased inserts and deletes', () => {
    for (const sql of [
      "run(db, `UPDATE passes AS p SET status = 'void' WHERE p.id = ?`, [id])",
      "run(db, `UPDATE passes p SET status = 'void' WHERE p.id = ?`, [id])",
      "run(db, `UPDATE passes INDEXED BY passes_org SET status = 'void' WHERE id = ?`, [id])",
      "run(db, `UPDATE passes NOT INDEXED SET status = 'void' WHERE id = ?`, [id])",
      "run(db, `UPDATE passes AS p INDEXED BY passes_org SET status = 'void'`, [])",
      'run(db, `INSERT INTO passes AS p (id) VALUES (?) ON CONFLICT DO NOTHING`, [id])',
      'run(db, `DELETE FROM passes AS x WHERE x.id = ?`, [id])',
      "run(db, `update or ignore scans as s set state = 'x' where s.id = ?`, [id])",
    ])
      expect(rules(sql), sql).toEqual(['raw-guarded-write']);
    // The stamp allowlist still applies through an alias.
    expect(
      rules('run(db, `UPDATE sessions AS s SET last_seen_at = ? WHERE s.id_hash = ?`)'),
    ).toEqual([]);
    expect(rules('run(db, `UPDATE counters AS c SET count = 1 WHERE c.key = ?`)')).toEqual([]);
  });

  it('flags a guarded table handed to a table-taking helper', () => {
    expect(rules("deleteInBatches(db, 'scans', 'at < ?', [before])")).toEqual([
      'raw-guarded-write',
    ]);
    expect(rules("casUpdate(db, { table: 'passes', id, version }, set)")).toEqual([
      'raw-guarded-write',
    ]);
    expect(rules("deleteInBatches(db, 'wallet_logs', 'at < ?', [before])")).toEqual([]);
    // Only the reviewed statements of an allowlisted file pass; this one is not among them.
    expect(
      rules("deleteInBatches(db, 'scans', 'at < ?', [b])", `${MOD}/scan/repo-scans.ts`),
    ).toEqual(['raw-guarded-write']);
  });

  it('flags dynamic and concatenated write targets unless allowlisted', () => {
    for (const sql of [
      `const t = 'passes'; run(db, \`UPDATE \${t} SET status = 'void' WHERE id = ?\`, [id])`,
      `run(db, \`DELETE FROM \${table} WHERE id = ?\`, [id])`,
      `run(db, \`INSERT OR IGNORE INTO main.\${t} (id) VALUES (?)\`, [id])`,
      "run(db, 'UPDATE ' + 'passes SET status = ? WHERE id = ?', [s, id])",
      'run(db, "DELETE FROM " + table + " WHERE id = ?", [id])',
      "run(db, 'UPDATE pas' + 'ses SET status = ?', [s])",
    ])
      expect(rules(sql), sql).toContain('dynamic-write');
    expect(
      rules(`run(db, \`DELETE FROM \${table} WHERE id = ?\`)`, 'src/worker/platform/batched.ts'),
    ).toEqual([]);
    // An upsert's DO UPDATE SET and a fixed table are not dynamic.
    expect(
      rules(
        `run(db, \`INSERT INTO counters (k) VALUES (?) ON CONFLICT (k) DO UPDATE SET \${set}\`)`,
      ),
    ).toEqual([]);
    expect(rules(`run(db, \`UPDATE counters SET n = \${n} WHERE k = ?\`)`)).toEqual([]);
    expect(rules(`run(db, \`update \${t} set n = 1\`)`)).toEqual(['dynamic-write']);
    // `update` is also a JS word.
    expect(rules(`const action = 'update' + suffix; log(\`update \${n} rows\`);`)).toEqual([]);
  });

  it('flags builder internals outside platform/authority*.ts', () => {
    for (const text of [
      "import { BUILDER, GrantedStatement as GS } from '../../platform/authority-granted.ts';",
      "import { prepareOf } from '../../platform/authority-batch.ts'; await db.batch(prepareOf(g).slice(1, -1))",
      "import { registerPrepare } from '../../platform/authority-batch.ts';",
      "import { newGrantedStatement } from '../../platform/authority-granted.ts';",
    ])
      expect(
        scanBrandImport(rel, text).map((f) => f.rule),
        text,
      ).toEqual(['builder-internal']);
    const internal = "import { newGrantedStatement } from './authority-granted.ts';";
    expect(scanBrandImport('src/worker/platform/authority.ts', internal)).toEqual([]);
    expect(scanBrandImport('src/worker/platform/authority-joined.ts', internal)).toEqual([]);
    expect(scanBrandImport('src/worker/platform/db.ts', internal).map((f) => f.rule)).toEqual([
      'builder-internal',
    ]);
    expect(
      scanBrandImport(rel, "import { builtOf } from '../../platform/authority-granted.ts';"),
    ).toEqual([]);
  });
});

describe('authority-scope rawCheck tenant terms', () => {
  const rel = `${MOD}/x/repo.ts`;
  const rules = (text: string, file = rel) => scanFile(file, text, owners).map((f) => f.rule);

  it('flags a positive EXISTS over a tenant table without a tenant term', () => {
    for (const text of [
      `rawCheck('lineage', "EXISTS (SELECT 1 FROM templates WHERE id = ? AND status = 'active')", ['t'])`,
      "rawCheck('lineage', `EXISTS (SELECT 1 FROM users u JOIN passes p ON p.owner_user_id = u.id WHERE p.id = ?)`, [id])",
      "rawCheck(reason, 'x = 1 AND EXISTS (SELECT 1 FROM workflow_runs w WHERE w.id = ?)', [id])",
      `rawCheck('lineage', \`EXISTS (SELECT 1 FROM scan_events e WHERE e.id = \${'?'})\`, [id])`,
    ])
      expect(rules(text), text).toEqual(['untenanted-check']);
  });

  it('passes NOT EXISTS, global tables, an actor tie and tenantCheck', () => {
    for (const text of [
      "rawCheck('lineage', \"NOT EXISTS (SELECT 1 FROM pass_credential_transfers t WHERE t.pass_id = ? AND t.state = 'pending')\", [id])",
      "rawCheck('actor', 'EXISTS (SELECT 1 FROM users u WHERE u.id = ?)', [id])",
      "rawCheck('org', 'EXISTS (SELECT 1 FROM orgs o WHERE o.id = a.org_id AND o.status = 1)')",
      "rawCheck('x', 'EXISTS (SELECT 1 FROM connection_webhook_items i WHERE i.id = ? AND NOT EXISTS (SELECT 1 FROM passes p WHERE p.id = i.pass_id))', [id])",
      "tenantCheck('lineage', 'EXISTS (SELECT 1 FROM templates t WHERE t.id = ? AND t.org_id = {org})', [id])",
    ])
      expect(rules(text), text).toEqual([]);
    expect(
      untenantedChecks(
        "rawCheck('x', 'EXISTS (SELECT 1 FROM passes p, scans s WHERE p.id = ?)', [id])",
      ),
    ).toEqual(['passes', 'scans']);
  });

  it('allowlists by file and table', () => {
    const text = "rawCheck('actor', 'EXISTS (SELECT 1 FROM api_keys k WHERE k.id = ?)', [id])";
    expect(rules(text, `${MOD}/passes/repo-authority.ts`)).toEqual([]);
    expect(
      rules(text.replace('api_keys k', 'passes k'), `${MOD}/passes/repo-authority.ts`),
    ).toEqual(['untenanted-check']);
  });

  it('bans the retired scan fence machinery', () => {
    const rel = `${MOD}/scan/repo-x.ts`;
    const cases: [string, string][] = [
      ['label', "stmt(db, 'SELECT ?/* scan-ephemeral-x */')"],
      ['slot', "stmt(db, \"SELECT json_extract('[]','$[0]')\")"],
      ['keyset', 'WHERE x AND credentialRefKeysetSql'],
      ['import', "import { x } from './repo-scanner-configuration-scope.ts';"],
      ['import', "import { x } from './repo-session-authority.ts';"],
      ['import', "import { balanceSqlAnd } from '../../platform/sql-balance.ts';"],
      ['balancer', 'balanceSqlAnd(sql)'],
    ];
    for (const [name, text] of cases)
      expect(
        scanBans(rel, text).map((f) => f.rule),
        name,
      ).toContain('banned');
    expect(
      scanBans(rel, "import { x } from './repo-output-authority-split-test-fixtures.ts';"),
    ).toEqual([]);
    expect(scanBans(rel, "stmt(db, 'SELECT 1 WHERE a = ?', [1])")).toEqual([]);
    expect(scanBans(`${MOD}/passes/repo-credential-keyset.ts`, 'credentialRefKeysetSql')).toEqual(
      [],
    );
    for (const owner of [
      'passes/repo-ops-retention.ts',
      'scan/repo-credential-tombstones.ts',
      'wallet-providers/repo-instance.ts',
    ])
      expect(scanBans(`${MOD}/${owner}`, 'credentialRefKeysetSql').map((f) => f.rule)).toContain(
        'banned',
      );
    const inline = 'EXISTS (SELECT 1 FROM credential_ref_keyset keyset WHERE keyset.id = 1)';
    expect(
      scanBans(`${MOD}/wallet-providers/repo-instance.ts`, inline).map((f) => f.rule),
    ).toContain('banned');
    expect(scanBans(`${MOD}/wallet-providers/repo-keyset-pin.ts`, inline)).toEqual([]);
    const join = 'JOIN credential_ref_keyset keyset ON keyset.id = 1';
    expect(scanBans(`${MOD}/wallet-providers/repo-instance.ts`, join).map((f) => f.rule)).toContain(
      'banned',
    );
    expect(scanBans(`${MOD}/wallet-providers/repo-keyset-pin.ts`, join)).toEqual([]);
    for (const helper of ['credentialRefKeysetMatch(c)', 'await matchesCredentialRefKeyset(db, c)'])
      expect(
        scanBans(`${MOD}/wallet-providers/repo-instance.ts`, helper).map((f) => f.rule),
        helper,
      ).toContain('banned');
    // Outside wallet-providers the helpers are the supported way to deny a foreign keyset.
    expect(
      scanBans(`${MOD}/scan/repo-credential-tombstones.ts`, 'credentialRefKeysetMatch(c)'),
    ).toEqual([]);
  });
});
