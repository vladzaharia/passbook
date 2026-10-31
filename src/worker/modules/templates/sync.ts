import { BAKED_BUILD_HASH, bakedTemplates } from '../../../generated/baked-templates.ts';
import type { PassJson } from '../../../passkit/types.ts';
import { first, placeholders, stmt } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { BakedTemplate } from './baked-types.ts';
import { insertVersionStmt } from './repo.ts';

const SETTING_KEY = 'templates.baked_hash';

export interface SyncSource {
  templates: readonly BakedTemplate[];
  hash: string;
}

export const generatedSource: SyncSource = { templates: bakedTemplates, hash: BAKED_BUILD_HASH };

const done = new Map<string, Promise<void>>();

/** Test hook: forget which build hashes this isolate already synced. */
export function resetBakedSync(): void {
  done.clear();
}

async function sync(ctx: ServiceContext, source: SyncSource): Promise<void> {
  const db = ctx.env.DB;
  const stored = await first<{ value: string }>(
    db,
    "SELECT value FROM settings WHERE scope = 'system' AND key = ?",
    [SETTING_KEY],
  );
  if (stored && JSON.parse(stored.value) === source.hash) return;

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
        assets: t.assets,
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
 * when the stored build hash matches, and run at most once per isolate per hash.
 */
export function syncBakedTemplates(
  ctx: ServiceContext,
  source: SyncSource = generatedSource,
): Promise<void> {
  const key = `${source.hash}`;
  let promise = done.get(key);
  if (!promise) {
    promise = sync(ctx, source);
    done.set(key, promise);
    promise.catch(() => done.delete(key));
  }
  return promise;
}
