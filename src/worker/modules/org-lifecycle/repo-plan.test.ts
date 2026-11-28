import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { makeEnv } from '../../../../test/helpers/env.ts';
import { fixtures, makeOrg, makeUser } from '../../../../test/helpers/factories.ts';
import {
  AUTHORITY_TABLES,
  GUARDED_TABLES,
  ORG_BEARING_TABLES,
} from '../../platform/authority-tables.ts';
import { all, run } from '../../platform/db.ts';
import { PURGE_KEEP, PURGE_NOT_TENANT, PURGE_STEPS, type PurgeStep } from './repo-plan.ts';
import { remaining } from './repo-purge.ts';

const isAuthority = (t: string) => (AUTHORITY_TABLES as readonly string[]).includes(t);

interface Fk {
  child: string;
  parent: string;
  column: string;
  action: string;
}

const flat = (): PurgeStep[] =>
  PURGE_STEPS.flatMap((s) => (Array.isArray(s) ? [...s] : [s as PurgeStep]));
const positionOf = (table: string) =>
  PURGE_STEPS.findIndex((s) =>
    (Array.isArray(s) ? s : [s as PurgeStep]).some((x) => x.table === table),
  );

async function schema() {
  const tables = (
    await all<{ name: string }>(
      env.DB,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name != 'd1_migrations'",
    )
  ).map((t) => t.name);
  const fks: Fk[] = [];
  const keyColumns = new Set<string>();
  for (const t of tables) {
    for (const f of await all<{ table: string; from: string; on_delete: string }>(
      env.DB,
      `SELECT "table", "from", on_delete FROM pragma_foreign_key_list('${t}')`,
    ))
      fks.push({ child: t, parent: f.table, column: f.from, action: f.on_delete });
    for (const c of await all<{ name: string; notnull: number; pk: number }>(
      env.DB,
      `SELECT name, "notnull", pk FROM pragma_table_info('${t}')`,
    ))
      if (c.notnull === 1 || c.pk > 0) keyColumns.add(`${t}.${c.name}`);
  }
  return { tables, fks, keyColumns };
}

/** The tables a step removes by cascade, each with the cascade edges that reach it. */
function cascades(tables: string[], fks: Fk[], keyColumns: Set<string>) {
  const removed = new Map<string, Fk[]>();
  const known = new Set(flat().map((s) => s.table));
  for (let changed = true; changed; ) {
    changed = false;
    for (const t of tables) {
      if (known.has(t) || removed.has(t)) continue;
      const via = fks.filter(
        (f) =>
          f.child === t &&
          f.action === 'CASCADE' &&
          f.parent !== 'orgs' &&
          (known.has(f.parent) || removed.has(f.parent)) &&
          keyColumns.has(`${t}.${f.column}`),
      );
      if (via.length === 0) continue;
      removed.set(t, via);
      changed = true;
    }
  }
  return removed;
}

describe('the purge plan against the migrated schema', () => {
  it('covers every table: a step, a cascade of one, kept, or not tenant data', async () => {
    const { tables, fks, keyColumns } = await schema();
    const cascaded = cascades(tables, fks, keyColumns);
    const steps = new Set(flat().map((s) => s.table));
    const unaccounted = tables.filter(
      (t) =>
        !steps.has(t) &&
        !cascaded.has(t) &&
        !(t in PURGE_KEEP) &&
        !(t in PURGE_NOT_TENANT) &&
        !isAuthority(t),
    );
    expect(
      unaccounted,
      'Add each to PURGE_STEPS, PURGE_KEEP or PURGE_NOT_TENANT (repo-plan.ts)',
    ).toEqual([]);
    for (const t of Object.keys(PURGE_KEEP)) expect(tables).toContain(t);
    for (const t of Object.keys(PURGE_NOT_TENANT)) expect(tables).toContain(t);
    for (const t of steps) expect(tables).toContain(t);
  });

  it('names every tenant table of the authority lists', async () => {
    const { tables, fks, keyColumns } = await schema();
    const cascaded = cascades(tables, fks, keyColumns);
    const steps = new Set(flat().map((s) => s.table));
    const unplanned = [...Object.keys(GUARDED_TABLES), ...ORG_BEARING_TABLES].filter(
      (t) =>
        !steps.has(t) &&
        !cascaded.has(t) &&
        !(t in PURGE_KEEP) &&
        !(t in PURGE_NOT_TENANT) &&
        !isAuthority(t),
    );
    expect(unplanned).toEqual([]);
  });

  it('removes a table before every table its rows are referenced from without a cascade', async () => {
    const { tables, fks, keyColumns } = await schema();
    const cascaded = cascades(tables, fks, keyColumns);
    /** When the table's rows go: its own step, or the earliest step of a table that cascades to it. */
    const when = (t: string): number => {
      const own = positionOf(t);
      if (own >= 0) return own;
      return Math.min(...(cascaded.get(t) ?? []).map((f) => when(f.parent)));
    };
    const problems: string[] = [];
    for (const f of fks) {
      if (f.action === 'CASCADE' || f.action === 'SET NULL' || f.child === f.parent) continue;
      const childGoes = steps(f.child, cascaded);
      const parentGoes = steps(f.parent, cascaded);
      if (!childGoes || !parentGoes) continue;
      if (when(f.child) > when(f.parent))
        problems.push(
          `${f.child}.${f.column} -> ${f.parent} (${f.action}) is removed after its parent`,
        );
    }
    expect(problems).toEqual([]);
  });

  it('purges the CLI sessions of an org with the org, ahead of the keys they point at', async () => {
    const f = fixtures(await makeEnv());
    const [org, other, user] = [await makeOrg(f), await makeOrg(f), await makeUser(f)];
    const add = (id: string, orgId: string) =>
      run(
        env.DB,
        `INSERT INTO cli_sessions (id, device_hash, code_mac, client, created_at, expires_at, user_id, org_id)
         VALUES (?1, ?1, ?1, '{}', 1, 2, ?2, ?3)`,
        [id, user.id, orgId],
      );
    await add('cli-a', org.id);
    await add('cli-b', other.id);
    const step = flat().find((s) => s.table === 'cli_sessions');
    expect(step).toBeDefined();
    expect(await remaining(env.DB, step as PurgeStep, org.id)).toBe(1);
    expect(positionOf('cli_sessions')).toBeLessThan(positionOf('api_keys'));
  });

  it('every step is valid SQL against the schema', async () => {
    const broken: string[] = [];
    for (const step of flat())
      await remaining(env.DB, step, 'no-such-org').catch((e: Error) =>
        broken.push(`${step.table}: ${e.message}`),
      );
    expect(broken).toEqual([]);
  });
});

const GATED_TRIGGERS = [
  'org_memberships_no_delete',
  'org_invitations_no_delete',
  'template_candidates_no_delete',
  'template_approvals_no_delete',
  'template_releases_no_delete',
  'template_version_extras_no_delete',
  'template_version_extra_sets_no_delete',
  'template_version_hashes_no_delete',
  'wallet_provider_credentials_no_delete',
  'wallet_provider_account_events_no_delete',
  'wallet_samsung_tombstones_no_delete',
  'wallet_provider_projection_evidence_history_no_delete',
  'wallet_provider_accounts_no_delete',
  'wallet_credential_versions_no_delete',
  'wallet_credential_events_no_delete',
  'wallet_credential_checks_no_delete',
  'wallet_enrolment_events_no_delete',
  'wallet_credentials_no_delete',
  'connection_webhook_unresolved_item_no_delete',
  'pass_credential_transfer_pending_no_pass_delete',
  'pass_credential_transfer_payload_no_delete',
];

describe('the purge gates of 0136', () => {
  it('every history trigger it rewrote still holds the purge clause (a later migration must keep it)', async () => {
    const rows = await all<{ name: string; sql: string }>(
      env.DB,
      `SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN (${GATED_TRIGGERS.map((n) => `'${n}'`).join(',')})`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual([...GATED_TRIGGERS].sort());
    for (const r of rows) expect(r.sql, r.name).toContain('o.purge_started_at IS NOT NULL');
  });
});

function steps(table: string, cascaded: Map<string, Fk[]>): boolean {
  return positionOf(table) >= 0 || cascaded.has(table);
}
