import { zipSync } from 'fflate';
import type { AuthContext } from '../../platform/auth.ts';
import { actorOf } from '../../platform/context.ts';
import { ConflictError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { startBulkReissue } from '../passes/bulk.ts';
import { audit } from './mutations.ts';
import { clearTemplateCache, createTemplateRegistry } from './registry.ts';
import { countPassesByVersion, setStatus } from './repo.ts';
import { detail, loadTemplate } from './service.ts';

/** Archived templates keep serving their passes; new passes cannot use them. */
export async function setArchived(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  archived: boolean,
) {
  const row = await loadTemplate(ctx, auth, id);
  if (row.origin === 'baked')
    throw new ForbiddenError('Built-in templates cannot be archived.', 'TEMPLATE_BAKED');
  const next = archived ? 'archived' : 'active';
  if (row.status !== next) {
    await setStatus(ctx.env.DB, id, next, ctx.clock.now());
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, row, archived ? 'template.archive' : 'template.restore');
  }
  return detail(ctx, auth, id);
}

/** Moves every pass on an older version to the active one (bulk_reissue workflow). */
export async function reissueTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<{ workflowInstanceId: string; passes: number }> {
  const row = await loadTemplate(ctx, auth, id);
  if (row.status !== 'active' || !row.activeVersion)
    throw new ConflictError('Restore the template first.', 'TEMPLATE_ARCHIVED');
  let passes = 0;
  for (const [version, n] of await countPassesByVersion(ctx.env.DB, id))
    if (version !== row.activeVersion) passes += n;
  if (passes === 0)
    throw new ConflictError('Every pass is on the active version.', 'NOTHING_TO_REISSUE');
  const actor = actorOf(auth);
  const workflowInstanceId = await startBulkReissue(
    ctx,
    { type: actor.type === 'device' ? 'system' : actor.type, id: actor.id },
    {
      templateId: id,
      version: row.activeVersion,
      ...(row.orgId ? { orgId: row.orgId } : {}),
      cause: 'template_upgrade',
    },
  );
  await audit(ctx, auth, row, 'template.reissue', { version: row.activeVersion, passes });
  return { workflowInstanceId, passes };
}

/** The active version as an uploadable package: pass.json, wallet.template.json and the images. */
export async function templatePackage(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = await loadTemplate(ctx, auth, id);
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await registry.resolve(id);
  const { org: _org, ...manifest } = template.manifest as typeof template.manifest & {
    org?: unknown;
  };
  const text = (value: unknown) => new TextEncoder().encode(`${JSON.stringify(value, null, 2)}\n`);
  const files: Record<string, Uint8Array> = {
    'pass.json': text(template.passJson),
    'wallet.template.json': text(manifest),
  };
  for (const asset of template.assets)
    files[asset.name] = new Uint8Array(
      await new Response(await registry.openAsset(template, asset.name)).arrayBuffer(),
    );
  return { bytes: zipSync(files, { level: 6 }), fileName: `${row.slug}.zip` };
}
