// Test helpers for the templates module. Not imported by production code.
import { createBehaviorRegistry } from '../../../passkit/behaviors/registry.ts';
import type { ManualClock } from '../../platform/clock.ts';
import type { AppEnv } from '../../platform/env.ts';
import { createServiceContext, type ServiceContext } from '../../platform/service-context.ts';
import type { BakedTemplate } from './baked-types.ts';
import {
  analyzeStage,
  dryRunStage,
  extractStage,
  type ImportParams,
  persistStage,
} from './import-pipeline.ts';
import { type Analysis, analyzePackage } from './package/analyze.ts';
import type { ImageTools } from './package/images.ts';
import { insertImport } from './repo.ts';
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

/** Runs every import stage in order, like the workflow, against the test environment. */
export async function importZip(
  env: AppEnv,
  clock: ManualClock,
  options: {
    orgId: string;
    zip: Uint8Array;
    name?: string;
    createdBy?: string | null;
    images?: ImageTools;
  },
): Promise<{
  p: ImportParams;
  ctx: ServiceContext;
  stages: string[];
  result: { templateId: string; version: string } | null;
}> {
  const ctx = createServiceContext(env, { clock });
  const uploadId = ctx.ids.id();
  const p: ImportParams = {
    uploadId,
    orgId: options.orgId,
    objectKey: `uploads/${uploadId}.zip`,
    createdBy: options.createdBy ?? null,
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
