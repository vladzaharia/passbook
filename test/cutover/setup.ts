import { env as bindings } from 'cloudflare:workers';
import { basicPackage, makePng } from '../../src/worker/modules/templates/package/fixtures.ts';
import { effectiveReleaseIdSql } from '../../src/worker/modules/templates/repo-release-heads.ts';
import { resetBakedSync, syncBakedTemplates } from '../../src/worker/modules/templates/sync.ts';
import { bakedFrom, sourceOf } from '../../src/worker/modules/templates/testing.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { createServiceContext } from '../../src/worker/platform/service-context.ts';
import { makeEnv, TEST_NOW } from '../helpers/index.ts';
import {
  addGrantLimitKey,
  dataFingerprint,
  finishMigrations,
  type Legacy,
  legacyDatabase,
  migrateForward,
  OWNER,
  SCAN,
  seedLegacy,
  starterPackage,
} from './legacy-seed.ts';
import { seedProduction } from './production-seed.ts';
import { runBootstrap } from './run-bootstrap.ts';

export const NOW = TEST_NOW;
export const TABLES = [
  'users',
  'orgs',
  'api_keys',
  'settings',
  'sessions',
  'magic_links',
  'signing_identities',
  'templates',
  'template_versions',
  'passes',
  'pass_versions',
  'devices',
  'registrations',
  'outbox',
  'scans',
  'scan_presence',
  'scan_gates',
  'pass_events',
];

const effectiveSql = `SELECT (${effectiveReleaseIdSql({
  templateIdSql: 'p.template_id',
  orgIdSql: 'p.org_id',
  modeSql: 'p.mode',
  providerSql: "'apple'",
})}) AS id FROM passes p WHERE p.id = ?`;

export const effective = (db: D1Database, passId: string) =>
  db.prepare(effectiveSql).bind(passId).first<{ id: string | null }>();

/** The same read on the 0069 schema: approvals have no `kind` yet, and 0093 makes every one of them `peer`. */
const effectiveBefore0093 = (db: D1Database, passId: string) =>
  db
    .prepare(effectiveSql.replaceAll("apr.kind != 'peer'", "'peer' != 'peer'"))
    .bind(passId)
    .first<{ id: string | null }>();

export interface Cutover {
  legacy: Legacy;
  before: Awaited<ReturnType<typeof dataFingerprint>>;
  beforeSync: Record<string, string | null>;
  env: AppEnv;
  /** The newest build the cutover synced; a kit that serves the migrated database must report it. */
  build: AppEnv['CF_VERSION'];
  bootstrapPlan: string[];
  bootstrapSql: string;
}

/**
 * 0024 data, then migrations 0025 to 0069, then the bootstrap, then the baked sync: the cutover in production order.
 * Then the token seal and 0070, which production ran after the promote.
 */
export async function runCutover(
  slot: number,
  options: { bumpStarter?: boolean; bumpStarters?: boolean; production?: boolean } = {},
): Promise<Cutover> {
  const db = await legacyDatabase(slot);
  const legacy = await seedLegacy(db, bindings.BUCKET);
  if (options.production) await seedProduction(db, bindings.BUCKET, legacy);
  const before = await dataFingerprint(db, TABLES);
  await migrateForward(db);
  await addGrantLimitKey(db);
  const { plan, sql } = await runBootstrap(db, OWNER, NOW);
  const beforeSync: Record<string, string | null> = {};
  for (const p of legacy.passes)
    beforeSync[p.id] = (await effectiveBefore0093(db, p.id))?.id ?? null;
  const env = {
    ...(await makeEnv({ DB: db, ASSETS: legacy.assets })),
    CF_VERSION: { id: 'cutover-worker', tag: '', timestamp: new Date(NOW - 1000).toISOString() },
  } as AppEnv;
  resetBakedSync();
  await syncBakedTemplates(
    createServiceContext(env, { clock: new ManualClock(NOW) }),
    sourceOf(legacy.baked, 'cutover-hash'),
  );
  let build = env.CF_VERSION;
  if (options.bumpStarter) {
    // The new build ships different baked content: the platform starter gets a new version.
    const bumped = await bakedFrom('starter', basicPackage({ 'logo.png': makePng(120, 50) }), {
      name: 'Starter',
    });
    bumped.template.manifest = { ...bumped.template.manifest, scan: SCAN } as never;
    for (const [k, v] of bumped.files) legacy.assets.files.set(k, v);
    const later = {
      ...env,
      CF_VERSION: {
        id: 'cutover-worker-2',
        tag: '',
        timestamp: new Date(NOW + 1000).toISOString(),
      },
    };
    build = later.CF_VERSION;
    resetBakedSync();
    await syncBakedTemplates(
      createServiceContext(later, { clock: new ManualClock(NOW + 2000) }),
      sourceOf([bumped, ...legacy.baked.slice(1)], 'cutover-hash-2'),
    );
    legacy.bumpedVersion = bumped.template.version;
  }
  if (options.bumpStarters) {
    // The two shipped starters get new content: the unassigned blueprint and the org-assigned one.
    const bumped = [
      await bakedFrom('starter-generic', starterPackage('Membership card', 130), {
        name: 'Membership card',
      }),
      await bakedFrom('starter-coupon', starterPackage('Coupon', 140), { name: 'Coupon' }),
    ];
    for (const f of bumped) {
      f.template.manifest = { ...f.template.manifest, scan: SCAN } as never;
      for (const [k, v] of f.files) legacy.assets.files.set(k, v);
    }
    const later = {
      ...env,
      CF_VERSION: {
        id: 'cutover-worker-3',
        tag: '',
        timestamp: new Date(NOW + 3000).toISOString(),
      },
    };
    build = later.CF_VERSION;
    resetBakedSync();
    await syncBakedTemplates(
      createServiceContext(later, { clock: new ManualClock(NOW + 4000) }),
      sourceOf([...legacy.baked.slice(0, 4), ...bumped], 'cutover-hash-3'),
    );
    legacy.bumpedStarters = bumped.map((f) => f.template.version);
  }
  await finishMigrations(db);
  return { legacy, before, beforeSync, env, build, bootstrapPlan: plan, bootstrapSql: sql };
}
