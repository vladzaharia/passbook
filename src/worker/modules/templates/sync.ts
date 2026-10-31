import { BAKED_BUILD_HASH, bakedTemplates } from '../../../generated/baked-templates.ts';
import type { AssetEntry, PassJson } from '../../../passkit/types.ts';
import { first, placeholders, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { BakedAsset, BakedTemplate } from './baked-types.ts';
import { insertVersionStmt } from './repo.ts';

const SETTING_KEY = 'templates.baked_hash';

export interface SyncSource {
  templates: readonly BakedTemplate[];
  hash: string;
}

export const generatedSource: SyncSource = { templates: bakedTemplates, hash: BAKED_BUILD_HASH };

// Settled results only: an in-flight promise is bound to the first request's I/O and can hang.
const done = new Set<string>();

/** Test hook: forget which build hashes this isolate already synced. */
export function resetBakedSync(): void {
  done.clear();
}

export function bakedR2Key(slug: string, version: string, name: string): string {
  return `templates/baked/${slug}/${version}/${name}`;
}

async function copyAsset(ctx: ServiceContext, t: BakedTemplate, asset: BakedAsset): Promise<void> {
  const key = bakedR2Key(t.slug, t.version, asset.name);
  if (await ctx.env.BUCKET.head(key)) return;
  const response = await ctx.env.ASSETS.fetch(
    new Request(new URL(asset.source.path, ctx.env.PUBLIC_BASE_URL)),
  );
  const html = response.headers.get('content-type')?.startsWith('text/html');
  if (!response.ok || html) {
    ctx.log.error('templates.baked_asset_missing', { templateId: t.id, asset: asset.name });
    throw new Error(`Baked asset missing: ${t.slug}/${asset.name}`);
  }
  await ctx.env.BUCKET.put(key, await response.arrayBuffer());
}

/** Content-addressed copies keep old baked versions buildable after a deploy replaces the static files. */
async function persistAssets(ctx: ServiceContext, source: SyncSource): Promise<boolean> {
  // Deployed Workers always have ASSETS; only bare dev and test runtimes lack it.
  if (!ctx.env.ASSETS) {
    ctx.log.warn('templates.baked_assets_not_persisted', {});
    return false;
  }
  const jobs = source.templates.flatMap((t) => t.assets.map((a) => ({ t, a })));
  for (let i = 0; i < jobs.length; i += 8)
    await Promise.all(jobs.slice(i, i + 8).map(({ t, a }) => copyAsset(ctx, t, a)));
  return true;
}

function r2Assets(t: BakedTemplate, persisted: boolean): AssetEntry[] {
  if (!persisted) return t.assets;
  return t.assets.map((a) => ({
    ...a,
    source: { kind: 'r2' as const, key: bakedR2Key(t.slug, t.version, a.name) },
  }));
}

async function sync(ctx: ServiceContext, source: SyncSource): Promise<void> {
  const db = ctx.env.DB;
  const stored = await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE scope = 'system' AND key = ?",
    [SETTING_KEY],
  );
  if (stored && JSON.parse(stored.value) === source.hash) return;

  const persisted = await persistAssets(ctx, source);
  const now = ctx.clock.now();
  const statements: D1PreparedStatement[] = [];
  const orgs = new Map<string, string>();
  for (const t of source.templates) if (t.org) orgs.set(t.org.slug, t.org.name);
  for (const [slug, name] of orgs)
    statements.push(
      stmt(
        db,
        `INSERT INTO orgs (id, slug, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (slug) DO NOTHING`,
        [ctx.ids.id(), slug, name, now, now],
      ),
    );
  for (const t of source.templates) {
    statements.push(
      stmt(
        db,
        `INSERT INTO templates (id, org_id, slug, name, description, origin, active_version, status, styles, created_at, updated_at)
         VALUES (?, (SELECT id FROM orgs WHERE slug = ?), ?, ?, ?, 'baked', ?, 'active', ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET org_id = excluded.org_id, name = excluded.name,
           description = excluded.description, active_version = excluded.active_version,
           status = 'active', styles = excluded.styles, updated_at = excluded.updated_at`,
        [
          t.id,
          t.org?.slug ?? null,
          t.slug,
          t.name,
          t.description,
          t.version,
          JSON.stringify(t.styles),
          now,
          now,
        ],
      ),
      insertVersionStmt(db, {
        templateId: t.id,
        version: t.version,
        manifest: t.manifest,
        passJson: t.passJson as PassJson,
        assets: r2Assets(t, persisted),
        report: t.report,
        createdBy: null,
        createdAt: now,
      }),
    );
  }
  const ids = source.templates.map((t) => t.id);
  statements.push(
    stmt(
      db,
      `UPDATE templates SET status = 'archived', updated_at = ?
       WHERE origin = 'baked' AND status = 'active'${ids.length ? ` AND id NOT IN (${placeholders(ids.length)})` : ''}`,
      [now, ...ids],
    ),
    stmt(
      db,
      `INSERT INTO settings (scope, key, value, updated_at) VALUES ('system', ?, ?, ?)
       ON CONFLICT (scope, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [SETTING_KEY, JSON.stringify(source.hash), now],
    ),
  );
  await db.batch(statements);
  ctx.log.info('templates.baked_synced', { count: source.templates.length });
}

/**
 * Upserts baked orgs, templates and versions so foreign keys and listings work. Idempotent: skipped
 * when the stored build hash matches, and remembered per isolate once it has settled.
 */
export async function syncBakedTemplates(
  ctx: ServiceContext,
  source: SyncSource = generatedSource,
): Promise<void> {
  if (done.has(source.hash)) return;
  await sync(ctx, source);
  done.add(source.hash);
}
