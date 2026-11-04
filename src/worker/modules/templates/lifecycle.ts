import { zipSync } from 'fflate';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { audit } from './mutations.ts';
import { clearTemplateCache, createTemplateRegistry } from './registry.ts';
import { setStatus } from './repo.ts';
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
