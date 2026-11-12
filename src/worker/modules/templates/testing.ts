// Test helpers for the templates module. Not imported by production code.
import { fixtures, makeSession, makeUser } from '../../../../test/helpers/index.ts';
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import type { ManualClock } from '../../platform/clock.ts';
import { run } from '../../platform/db.ts';
import type { AppEnv } from '../../platform/env.ts';
import {
  createJobContext,
  createServiceContext,
  type ServiceContext,
} from '../../platform/service-context.ts';
import { createSessionStore } from '../auth/sessions.ts';
import { authorizeTemplateWrite, type TemplateAuthority } from './access.ts';
import type { BakedTemplate } from './baked-types.ts';
import {
  analyzeStage,
  dryRunStage,
  extractStage,
  type ImportParams,
  persistStage,
  startImport,
} from './import-pipeline.ts';
import { type Analysis, analyzePackage } from './package/analyze.ts';
import type { ImageTools } from './package/images.ts';
import { insertImport } from './repo.ts';
import {
  getAuthorFixtureMembership,
  insertAuthorFixtureMembership,
} from './repo-author-fixtures.ts';
import type { SyncSource } from './sync.ts';

export interface FakeAssets extends Fetcher {
  files: Map<string, Uint8Array>;
}

/** Stand-in for the ASSETS binding: serves a path -> bytes map. */
export function fakeAssets(files = new Map<string, Uint8Array>()): FakeAssets {
  return {
    files,
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const bytes = files.get(url.pathname);
      return bytes ? new Response(bytes as BufferSource) : new Response('missing', { status: 404 });
    },
    connect: () => {
      throw new Error('not supported');
    },
  } as unknown as FakeAssets;
}

export interface BakedFixture {
  template: BakedTemplate;
  files: Map<string, Uint8Array>;
}

/** Builds a baked template the way tools/build-templates.ts would, in memory. */
export async function bakedFrom(
  slug: string,
  files: Map<string, Uint8Array>,
  options: { org?: { slug: string; name: string }; name?: string } = {},
): Promise<BakedFixture> {
  const result = await analyzePackage(files, {
    uploaded: false,
    fallbackName: options.name ?? slug,
    name: options.name,
    behaviors: createBehaviorRegistry([]),
  });
  if (!('version' in result)) throw new Error(JSON.stringify(result.report));
  const a = result as Analysis;
  const base = `/templates/${slug}/${a.version}`;
  const served = new Map<string, Uint8Array>();
  for (const [name, bytes] of a.files) served.set(`${base}/${name}`, bytes);
  for (const extra of a.extras) {
    const bytes = files.get(extra.name);
    if (bytes) served.set(`${base}/${extra.name}`, bytes);
  }
  return {
    files: served,
    template: {
      id: `baked:${slug}`,
      slug,
      version: a.version,
      name: a.manifest.name,
      description: a.manifest.description ?? null,
      org: options.org ?? null,
      styles: a.styles,
      manifest: a.manifest,
      passJson: a.passJson,
      assets: a.assets.map((x) => ({
        ...x,
        source: { kind: 'static' as const, path: `${base}/${x.name}` },
      })),
      extras: a.extras.map((e) => ({ ...e, path: `${base}/${e.name}` })),
      report: a.report,
    },
  };
}

export function sourceOf(fixtures: BakedFixture[], hash = 'test-hash'): SyncSource {
  return { templates: fixtures.map((f) => f.template), hash };
}

export const noImages: ImageTools = {};

export interface TemplateAuthorFixture {
  authority: TemplateAuthority;
  userId: string;
  membershipId: string;
  sessionId: string;
}

/** Creates a persisted session and org grant for an import principal. */
export async function templateAuthor(
  env: AppEnv,
  clock: ManualClock,
  orgId: string,
  userId?: string,
): Promise<TemplateAuthorFixture> {
  const f = fixtures(env, clock);
  const actor = userId ?? (await makeUser(f)).id;
  const existing = await getAuthorFixtureMembership(env.DB, orgId, actor);
  let membershipId = existing?.id;
  if (!membershipId) {
    const invitationId = f.ids.id();
    membershipId = f.ids.id();
    const now = clock.now();
    await insertAuthorFixtureMembership(env.DB, {
      orgId,
      userId: actor,
      invitationId,
      membershipId,
      token: f.ids.token(),
      now,
    });
  }
  const session = await makeSession(f, { userId: actor });
  const auth = await createSessionStore(env, clock).resolve(session.cookieValue);
  if (!auth) throw new Error('The persisted import session did not resolve');
  const authority = await authorizeTemplateWrite(
    createServiceContext(env, { clock }),
    auth,
    orgId,
    'templates:author',
  );
  return { authority, userId: actor, membershipId, sessionId: auth.sessionId };
}

/** Runs every import stage in order, like the workflow, against the test environment. */
export async function importZip(
  env: AppEnv,
  clock: ManualClock,
  options: {
    orgId: string;
    zip: Uint8Array;
    name?: string;
    createdBy?: string | null;
    authority?: TemplateAuthority;
    images?: ImageTools;
  },
): Promise<{
  p: ImportParams;
  ctx: ServiceContext;
  stages: string[];
  result: { templateId: string; version: string } | null;
}> {
  const ctx = createJobContext(env, 'template-import', { clock });
  const uploadId = ctx.ids.id();
  const authority =
    options.authority ??
    (await templateAuthor(env, clock, options.orgId, options.createdBy ?? undefined)).authority;
  const p: ImportParams = {
    uploadId,
    orgId: options.orgId,
    objectKey: `uploads/${uploadId}.zip`,
    createdBy: options.createdBy ?? authority.userId,
    authority,
  };
  await env.BUCKET.put(p.objectKey, options.zip);
  await insertImport(env.DB, {
    uploadId,
    orgId: options.orgId,
    name: options.name ?? null,
    objectKey: p.objectKey,
    createdBy: p.createdBy,
    now: clock.now(),
  });
  await startImport(ctx, p);
  const stages: string[] = [];
  const steps: [string, () => Promise<{ ok: boolean }>][] = [
    ['extract', () => extractStage(ctx, p)],
    ['analyze', () => analyzeStage(ctx, p, options.images ?? noImages)],
    ['dry-run', () => dryRunStage(ctx, p)],
  ];
  for (const [name, run] of steps) {
    stages.push(name);
    if (!(await run()).ok) return { p, ctx, stages, result: null };
  }
  stages.push('persist');
  return { p, ctx, stages, result: await persistStage(ctx, p) };
}

/** Fixture only: flips a template's status directly. Production changes it through a grant. */
export async function setTemplateStatus(
  db: D1Database,
  id: string,
  status: 'active' | 'archived' | 'deleted',
  now: number,
): Promise<void> {
  await run(
    db,
    'UPDATE templates SET status = ?, updated_at = MAX(updated_at + 1, ?) WHERE id = ?',
    [status, now, id],
  );
}

/**
 * Test hook: an env whose database runs `action` just before the first batch (every batch with
 * `always`) that contains a statement matching `sql`. `fired()` says whether it ran, so a test cannot
 * pass vacuously. It models a change committed between a request's checks and its write.
 */
export function watchBatch(
  env: AppEnv,
  sql: RegExp,
  action: () => Promise<unknown>,
  options: { always?: boolean } = {},
): { env: AppEnv; fired: () => number } {
  let seen = false;
  let fired = 0;
  const DB = new Proxy(env.DB, {
    get(target, prop) {
      if (prop === 'prepare')
        return (text: string) => {
          if (sql.test(text)) seen = true;
          return target.prepare(text);
        };
      if (prop === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (seen && (options.always || fired === 0)) {
            fired++;
            seen = false;
            await action();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { env: { ...env, DB }, fired: () => fired };
}

/** `watchBatch` for tests that only need the env. */
export function beforeBatch(env: AppEnv, sql: RegExp, action: () => Promise<unknown>): AppEnv {
  return watchBatch(env, sql, action).env;
}
