import type { z } from 'zod';
import { PassBuildError } from '../../../passkit/build.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { Json } from '../../../shared/contracts/common.ts';
import type {
  ImportStatusSchema,
  PreviewRequestSchema,
  PreviewResponseSchema,
  TemplateDetailSchema,
  TemplateListQuerySchema,
  TemplateListSchema,
  TemplateSummarySchema,
  TemplateVersionDetailSchema,
} from '../../../shared/contracts/index.ts';
import { type AuthContext, assertOrgAccess } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { previewPass } from './build-check.ts';
import { createTemplateRegistry } from './registry.ts';
import {
  countPasses,
  getImport,
  getOrgName,
  getTemplate,
  getVersion,
  type ListedTemplate,
  listTemplates,
  listVersions,
  type TemplateRow,
  type VersionRow,
} from './repo.ts';
import { syncBakedTemplates } from './sync.ts';

type Summary = z.infer<typeof TemplateSummarySchema>;
type Detail = z.infer<typeof TemplateDetailSchema>;
type VersionDetail = z.infer<typeof TemplateVersionDetailSchema>;

export function summaryOf(row: TemplateRow, passCount: number): Summary {
  return {
    id: row.id,
    orgId: row.orgId,
    slug: row.slug,
    name: row.name,
    description: row.description,
    origin: row.origin,
    status: row.status,
    activeVersion: row.activeVersion,
    styles: row.styles,
    passCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function versionDto(v: VersionRow, active: string | null) {
  return {
    version: v.version,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    assets: v.assets.map(({ source: _source, ...asset }) => asset),
    report: v.report,
    active: v.version === active,
  };
}

/** Loads a template the caller may see. Org-scoped API keys only see their org and platform rows. */
export async function loadTemplate(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<TemplateRow> {
  await syncBakedTemplates(ctx);
  const row = await getTemplate(ctx.env.DB, id);
  if (!row || row.status === 'deleted')
    throw new NotFoundError('Template not found.', 'TEMPLATE_NOT_FOUND');
  if (row.orgId) assertOrgAccess(auth, row.orgId);
  return row;
}

export async function list(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: z.infer<typeof TemplateListQuerySchema>,
): Promise<z.infer<typeof TemplateListSchema>> {
  await syncBakedTemplates(ctx);
  let orgId: string | undefined = query.orgId;
  if (auth?.kind === 'api_key' && auth.orgId !== null) {
    if (orgId) assertOrgAccess(auth, orgId);
    orgId = auth.orgId;
  }
  let cursor: { createdAt: number; id: string } | null = null;
  if (query.cursor) {
    const [at, ...rest] = query.cursor.split(':');
    const createdAt = Number(at);
    if (!Number.isFinite(createdAt) || rest.length === 0)
      throw new ValidationError('Invalid cursor.', [], 'INVALID_CURSOR');
    cursor = { createdAt, id: rest.join(':') };
  }
  const rows: ListedTemplate[] = await listTemplates(ctx.env.DB, {
    orgId,
    origin: query.origin,
    status: query.status,
    includeArchived: query.includeArchived,
    limit: query.limit + 1,
    cursor,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => summaryOf(r, r.passCount)),
    nextCursor: rows.length > query.limit && last ? `${last.createdAt}:${last.id}` : null,
  };
}

export async function detail(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
): Promise<Detail> {
  const row = await loadTemplate(ctx, auth, id);
  const versions = await listVersions(ctx.env.DB, id);
  const active = versions.find((v) => v.version === row.activeVersion);
  if (!active) throw new NotFoundError('Template has no active version.', 'TEMPLATE_NOT_FOUND');
  return {
    ...summaryOf(row, await countPasses(ctx.env.DB, id)),
    inputSchema: active.manifest.inputs as Json,
    sample: active.manifest.sample,
    manifest: active.manifest as unknown as Json,
    versions: versions.map((v) => versionDto(v, row.activeVersion)),
  };
}

export async function versionDetail(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  version: string,
): Promise<VersionDetail> {
  const row = await loadTemplate(ctx, auth, id);
  const v = await getVersion(ctx.env.DB, id, version);
  if (!v) throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  return {
    ...versionDto(v, row.activeVersion),
    manifest: v.manifest as unknown as Json,
    passJson: v.passJson,
  };
}

const TYPES: Record<string, string> = {
  png: 'image/png',
  json: 'application/json',
  strings: 'application/octet-stream',
};

export interface AssetStream {
  stream: ReadableStream<Uint8Array>;
  contentType: string;
  sha1: string | null;
}

export async function openVersionAsset(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  version: string,
  name: string,
): Promise<AssetStream> {
  await loadTemplate(ctx, auth, id);
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await registry.resolve(id, version);
  const entry = template.assets.find((a) => a.name === name);
  const contentType = TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
  if (entry)
    return { stream: await registry.openAsset(template, name), contentType, sha1: entry.sha1 };
  return { stream: await registry.openExtra(template, name), contentType, sha1: null };
}

export async function preview(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: z.infer<typeof PreviewRequestSchema>,
): Promise<z.infer<typeof PreviewResponseSchema>> {
  const row = await loadTemplate(ctx, auth, id);
  const template: ResolvedTemplate = await createTemplateRegistry(ctx.env, { ctx }).resolve(
    id,
    body.version,
  );
  const org = row.orgId ? await getOrgName(ctx.env.DB, row.orgId) : null;
  try {
    const result = previewPass(
      ctx.env,
      template,
      body.input ?? template.manifest.sample,
      org?.name ?? row.name,
      new Date(ctx.clock.now()),
    );
    return {
      passJson: result.passJson,
      warnings: result.issues,
      assetBaseUrl: `${baseUrl(ctx.env)}/api/v1/templates/${encodeURIComponent(id)}/versions/${template.version}/assets`,
    };
  } catch (error) {
    if (error instanceof PassBuildError)
      throw new ValidationError(
        error.message,
        error.report.issues.map((i) => ({ path: i.path ?? '', message: i.message, code: i.code })),
        error.code === 'INVALID_INPUT' ? 'INVALID_INPUT' : 'VALIDATION',
      );
    throw error;
  }
}

export async function importStatus(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  uploadId: string,
): Promise<z.infer<typeof ImportStatusSchema>> {
  const row = await getImport(ctx.env.DB, uploadId);
  if (!row) throw new NotFoundError('Upload not found.', 'UPLOAD_NOT_FOUND');
  assertOrgAccess(auth, row.orgId);
  return {
    uploadId,
    status: row.workflowStatus ?? 'queued',
    step: row.step,
    templateId: row.templateId,
    version: row.version,
    report: row.report,
    error: row.error,
  };
}
