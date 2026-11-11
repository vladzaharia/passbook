import { readdirSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  expandBraces,
  ownerOf,
  parseAppendixA,
  scanBrandImport,
  scanFile,
  scanJobContext,
  scanTree,
} from './authority-scope.ts';

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
    expect(scanBrandImport(`${MOD}/connections/routes.ts`, ingress)).toHaveLength(1);
    expect(scanBrandImport(`${MOD}/connections/repo-grants.ts`, ingress)).toEqual([]);
    expect(scanBrandImport(`${MOD}/connections/webhooks.ts`, ingress)).toEqual([]);
    expect(scanBrandImport('src/worker/platform/service-context.ts', imp)).toEqual([]);
    expect(scanBrandImport('src/worker/platform/authority.ts', imp)).toEqual([]);
    expect(scanBrandImport(`${MOD}/x/routes.test.ts`, imp)).toEqual([]);
  });

  it('suppresses raw guarded writes only in reviewed files, and ignores summary prose for REPLACE', () => {
    const write = 'run(db, "UPDATE users SET status = ? WHERE id = ?")';
    expect(scanFile(`${MOD}/users/repo.ts`, write, owners).map((f) => f.rule)).toEqual([]);
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

  it('the repository has no fence match without an owner', () => {
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
    expect(scanTree(doc, files).filter((f) => f.rule === 'unowned')).toEqual([]);
  });
});

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
