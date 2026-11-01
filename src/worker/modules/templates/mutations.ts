import type { z } from 'zod';
import type { AssetEntry, TemplateManifest, ValidationIssue } from '../../../passkit/types.ts';
import type {
  ActivateVersionSchema,
  CloneTemplateSchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { actorOf } from '../../platform/context.ts';
import { classifyD1Error } from '../../platform/db.ts';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  UnavailableError,
  ValidationError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { recordAudit } from '../audit/service.ts';
import { behaviors, dryRun } from './build-check.ts';
import { contentVersion } from './package/hash.ts';
import { validateManifest } from './package/manifest.ts';
import { stylesOf } from './package/slots.ts';
import { commitVersion, planTemplate, slugify } from './persist.ts';
import { clearTemplateCache, createTemplateRegistry, r2Key, r2Prefix } from './registry.ts';
import {
  activateStmt,
  countPasses,
  deleteTemplate,
  getOrgName,
  getVersion,
  insertWorkflowRun,
  listVersions,
  setStatus,
  setWorkflowRun,
  type TemplateRow,
} from './repo.ts';
import { detail, loadTemplate } from './service.ts';

function baked(row: TemplateRow): ForbiddenError | null {
  return row.origin === 'baked'
    ? new ForbiddenError('Baked templates cannot be changed. Clone it first.', 'TEMPLATE_BAKED')
    : null;
}

export function audit(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  row: { id: string; orgId: string | null },
  action: string,
  detailData: Record<string, unknown> = {},
) {
  const actor = actorOf(auth);
  return recordAudit(ctx, {
    orgId: row.orgId,
    actorType: actor.type,
    actorId: actor.id,
    action,
    targetType: 'template',
    targetId: row.id,
    detail: detailData,
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function cloneTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: z.infer<typeof CloneTemplateSchema>,
) {
  const source = await loadTemplate(ctx, auth, id);
  const org = await getOrgName(ctx.env.DB, body.orgId);
  if (!org) throw new NotFoundError('Organization not found.', 'ORG_NOT_FOUND');
  const name = body.name ?? `${source.name} copy`;
  const slug = slugify(name);
  const plan = await planTemplate(ctx, org.id, slug);
  if (!plan.isNew)
    throw new ConflictError(
      'A template with this name exists. Pick another name.',
      'TEMPLATE_EXISTS',
    );

  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await registry.resolve(id);
  const sourceVersion = await getVersion(ctx.env.DB, id, template.version);
  const manifest = { ...template.manifest, name } as TemplateManifest & { org?: unknown };
  delete manifest.org;
  const sha = new Map(template.assets.map((a) => [a.name, a.sha1]));
  const version = await contentVersion({
    passJson: template.passJson,
    manifest,
    assets: template.assets.map((a) => ({ name: a.name, sha1: sha.get(a.name) ?? '' })),
  });
  const assets: AssetEntry[] = [];
  for (const asset of template.assets) {
    const key = r2Key(org.id, plan.templateId, version, asset.name);
    await ctx.env.BUCKET.put(key, await readAll(await registry.openAsset(template, asset.name)));
    assets.push({ ...asset, source: { kind: 'r2', key } });
  }
  await commitVersion(ctx, {
    plan,
    orgId: org.id,
    slug,
    name,
    description: manifest.description ?? null,
    createdBy: auth?.kind === 'session' ? auth.userId : null,
    body: {
      version,
      manifest,
      passJson: template.passJson,
      assets,
      report: sourceVersion?.report ?? { ok: true, issues: [] },
      styles: stylesOf(template.passJson),
    },
  });
  await audit(ctx, auth, { id: plan.templateId, orgId: org.id }, 'template.clone', {
    sourceId: id,
    sourceVersion: template.version,
  });
  return detail(ctx, auth, plan.templateId);
}

export async function activateVersion(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: z.infer<typeof ActivateVersionSchema>,
) {
  const row = await loadTemplate(ctx, auth, id);
  const denied = baked(row);
  if (denied) throw denied;
  if (row.status !== 'active')
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');
  const version = await getVersion(ctx.env.DB, id, body.version);
  if (!version)
    throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  if (!version.report.ok)
    throw new ConflictError('This version has validation errors.', 'VERSION_INVALID');
  await activateStmt(ctx.env.DB, id, version.version, {
    name: version.manifest.name,
    description: version.manifest.description ?? null,
    styles: stylesOf(version.passJson),
    now: ctx.clock.now(),
  }).run();
  clearTemplateCache(ctx.env, id);

  let workflowId: string | null = null;
  let rebuildFailed = false;
  if (body.rebuildPasses) {
    workflowId = `br-${ctx.ids.id()}`;
    await insertWorkflowRun(ctx.env.DB, {
      instanceId: workflowId,
      kind: 'bulk_reissue',
      orgId: row.orgId,
      targetId: id,
      now: ctx.clock.now(),
    });
    try {
      await ctx.env.BULK_REISSUE.create({
        id: workflowId,
        params: {
          templateId: id,
          version: version.version,
          orgId: row.orgId,
          cause: 'template_upgrade',
        },
      });
    } catch (error) {
      ctx.log.error('templates.workflow_start_failed', {
        orgId: row.orgId,
        error: error instanceof Error ? error.name : 'unknown',
      });
      await setWorkflowRun(ctx.env.DB, workflowId, 'errored', ctx.clock.now(), {
        errorCode: 'WORKFLOW_START',
      });
      workflowId = null;
      rebuildFailed = true;
    }
  }
  await audit(ctx, auth, row, 'template.activate', {
    version: version.version,
    previous: row.activeVersion,
    rebuild: workflowId,
  });
  if (rebuildFailed)
    throw new UnavailableError(
      'The version is active, but the pass rebuild did not start. Start it again.',
      'WORKFLOW_START',
    );
  return detail(ctx, auth, id);
}

export async function replaceManifest(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  manifest: TemplateManifest,
) {
  const row = await loadTemplate(ctx, auth, id);
  const denied = baked(row);
  if (denied) throw denied;
  if (row.status !== 'active')
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const current = await registry.resolve(id);
  const issues: ValidationIssue[] = validateManifest(manifest, current.passJson, {
    uploaded: true,
    behaviors,
  });
  const next = { ...current, manifest };
  if (!issues.some((i) => i.severity === 'error')) {
    const org = row.orgId ? await getOrgName(ctx.env.DB, row.orgId) : null;
    issues.push(
      ...(await dryRun(
        ctx.env,
        next,
        async (name) => readAll(await registry.openAsset(current, name)),
        org?.name ?? row.name,
        new Date(ctx.clock.now()),
      )),
    );
  }
  if (issues.some((i) => i.severity === 'error'))
    throw new ValidationError(
      'The manifest is invalid.',
      issues
        .filter((i) => i.severity === 'error')
        .map((i) => ({ path: i.path ?? '', message: i.message, code: i.code })),
      'MANIFEST_INVALID',
    );
  const version = await contentVersion({
    passJson: current.passJson,
    manifest,
    assets: current.assets,
  });
  if (version !== current.version) {
    await commitVersion(ctx, {
      plan: { templateId: id, isNew: false, existing: row },
      orgId: row.orgId ?? '',
      slug: row.slug,
      name: manifest.name,
      description: manifest.description ?? null,
      createdBy: auth?.kind === 'session' ? auth.userId : null,
      body: {
        version,
        manifest,
        passJson: current.passJson,
        assets: current.assets,
        report: { ok: true, issues },
        styles: current.styles,
      },
    });
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, row, 'template.manifest', { version, previous: current.version });
  }
  return detail(ctx, auth, id);
}

async function deletePrefix(ctx: ServiceContext, prefix: string): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await ctx.env.BUCKET.list({ prefix, cursor, limit: 500 });
    if (page.objects.length) await ctx.env.BUCKET.delete(page.objects.map((o) => o.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

/** Assets stay under the org they were uploaded for, so reassigning must not change where to delete. */
async function storageOrg(ctx: ServiceContext, row: TemplateRow): Promise<string | null> {
  for (const v of await listVersions(ctx.env.DB, row.id))
    for (const a of v.assets) {
      const m = a.source.kind === 'r2' ? a.source.key.match(/^templates\/([^/]+)\//) : null;
      if (m) return m[1] === 'platform' ? null : (m[1] ?? null);
    }
  return row.orgId;
}

/** Hard delete when no pass references any version; otherwise archive. */
export async function removeTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<'deleted' | 'archived'> {
  const row = await loadTemplate(ctx, auth, id);
  const denied = baked(row);
  if (denied) throw denied;
  const archive = async () => {
    await setStatus(ctx.env.DB, id, 'archived', ctx.clock.now());
    clearTemplateCache(ctx.env, id);
    await audit(ctx, auth, row, 'template.archive');
    return 'archived' as const;
  };
  if ((await countPasses(ctx.env.DB, id)) > 0) return archive();
  const prefix = r2Prefix(await storageOrg(ctx, row), id);
  try {
    await deleteTemplate(ctx.env.DB, id);
  } catch (error) {
    // A pass was created after the count; the foreign key keeps the rows.
    if (classifyD1Error(error)?.kind === 'foreign_key') return archive();
    throw error;
  }
  clearTemplateCache(ctx.env, id);
  await deletePrefix(ctx, prefix);
  await audit(ctx, auth, row, 'template.delete', { slug: row.slug });
  return 'deleted';
}
