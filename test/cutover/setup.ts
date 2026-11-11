import { env as bindings } from 'cloudflare:workers';
import { basicPackage, makePng } from '../../src/worker/modules/templates/package/fixtures.ts';
import { effectiveReleaseIdSql } from '../../src/worker/modules/templates/repo-release-heads.ts';
import { resetBakedSync, syncBakedTemplates } from '../../src/worker/modules/templates/sync.ts';
import { bakedFrom, sourceOf } from '../../src/worker/modules/templates/testing.ts';
import { ManualClock } from '../../src/worker/platform/clock.ts';
import type { AppEnv } from '../../src/worker/platform/env.ts';
import { createServiceContext } from '../../src/worker/platform/service-context.ts';
import { makeEnv } from '../helpers/index.ts';
import {
  dataFingerprint,
  type Legacy,
  legacyDatabase,
  migrateForward,
  OWNER,
  SCAN,
  seedLegacy,
} from './legacy-seed.ts';
import { runBootstrap } from './run-bootstrap.ts';

export const NOW = Date.now();
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

export const effective = (db: D1Database, passId: string) =>
  db
    .prepare(
      `SELECT (${effectiveReleaseIdSql({
        templateIdSql: 'p.template_id',
        orgIdSql: 'p.org_id',
        modeSql: 'p.mode',
        providerSql: "'apple'",
      })}) AS id FROM passes p WHERE p.id = ?`,
    )
    .bind(passId)
    .first<{ id: string | null }>();

export interface Cutover {
  legacy: Legacy;
  before: Awaited<ReturnType<typeof dataFingerprint>>;
  beforeSync: Record<string, string | null>;
  env: AppEnv;
  bootstrapPlan: string[];
}

/** 0024 data, then migrations 0025+, then the bootstrap, then the baked sync: the cutover in production order. */
export async function runCutover(
  slot: number,
  options: { bumpStarter?: boolean } = {},
): Promise<Cutover> {
  const db = await legacyDatabase(slot);
  const legacy = await seedLegacy(db, bindings.BUCKET);
  const before = await dataFingerprint(db, TABLES);
  await migrateForward(db);
  const { plan } = await runBootstrap(db, OWNER, NOW);
  const beforeSync: Record<string, string | null> = {};
  for (const p of legacy.passes) beforeSync[p.id] = (await effective(db, p.id))?.id ?? null;
  const env = {
    ...(await makeEnv({ DB: db, ASSETS: legacy.assets })),
    CF_VERSION: { id: 'cutover-worker', tag: '', timestamp: new Date(NOW - 1000).toISOString() },
  } as AppEnv;
  resetBakedSync();
  await syncBakedTemplates(
    createServiceContext(env, { clock: new ManualClock(NOW) }),
    sourceOf(legacy.baked, 'cutover-hash'),
  );
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
    resetBakedSync();
    await syncBakedTemplates(
      createServiceContext(later, { clock: new ManualClock(NOW + 2000) }),
      sourceOf([bumped, ...legacy.baked.slice(1)], 'cutover-hash-2'),
    );
    legacy.bumpedVersion = bumped.template.version;
  }
  return { legacy, before, beforeSync, env, bootstrapPlan: plan };
}
