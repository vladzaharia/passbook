import { zipSync } from 'fflate';
import type { AuthContext } from '../../platform/auth.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import {
  archiveTemplate,
  authorizeTemplateMutation,
  resolveCurrentTemplate,
  restoreTemplate,
} from './mutations.ts';
import { createTemplateRegistry } from './registry.ts';
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
  const authority = await authorizeTemplateMutation(ctx, auth, row, 'templates:publish');
  if (archived) {
    if (row.status !== 'archived') await archiveTemplate(ctx, auth, row, authority);
  } else if (row.status === 'archived') {
    await restoreTemplate(ctx, auth, row, authority);
  }
  return detail(ctx, auth, id);
}

/** Export the active version or, for an unpublished template, its latest draft. */
export async function templatePackage(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  orgId?: string,
): Promise<{ bytes: Uint8Array; fileName: string }> {
  const row = await loadTemplate(ctx, auth, id, orgId);
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await resolveCurrentTemplate(ctx, registry, row);
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
