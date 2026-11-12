import type { z } from 'zod';
import type { Json } from '../../../shared/contracts/common.ts';
import type {
  ImportStatusSchema,
  TemplateDetailSchema,
  TemplateListQuerySchema,
  TemplateListSchema,
  TemplateSummarySchema,
  TemplateVersionDetailSchema,
  UploadListSchema,
} from '../../../shared/contracts/index.ts';
import { type AuthContext, assertOrgAccess, modeOf } from '../../platform/auth.ts';
import { NotFoundError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { createTemplateRegistry } from './registry.ts';
import {
  countPassesByVersion,
  getImport,
  getOrgName,
  getVersion,
  listRecentImports,
  listVersions,
  olderLivePasses,
  type TemplateRow,
  type VersionRow,
} from './repo.ts';
import { type ListedTemplate, listTemplates } from './repo-list.ts';
import { hasApprovedLiveHead } from './repo-mutations.ts';
import { olderLivePassesForOrg } from './repo-usage.ts';
import {
  isPlatformAdmin,
  loadTemplate,
  passUsageOrg,
  requireTemplateOrgRead,
  requireTemplateReader,
  templateCollectionOrg,
} from './service-access.ts';
import { syncBakedTemplates } from './sync.ts';

export { loadTemplate } from './service-access.ts';
export { preview, previewMany } from './service-preview.ts';

type Summary = z.infer<typeof TemplateSummarySchema>;
type Detail = z.infer<typeof TemplateDetailSchema>;
type VersionDetail = z.infer<typeof TemplateVersionDetailSchema>;

export function summaryOf(row: TemplateRow, passCount: number, orgName: string | null): Summary {
  return {
    id: row.id,
    orgId: row.orgId,
    orgName,
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

function versionDto(v: VersionRow, active: VersionRow | undefined, passCount = 0) {
  return {
    version: v.version,
    createdAt: v.createdAt,
    createdBy: v.createdBy,
    assets: v.assets.map(({ source: _source, ...asset }) => asset),
    report: v.report,
    active: v.version === active?.version,
    displayOnly:
      v.version !== active?.version &&
      v.buildKey !== null &&
      active?.buildKey != null &&
      v.buildKey === active.buildKey,
    passCount,
  };
}

export async function list(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: z.infer<typeof TemplateListQuerySchema>,
): Promise<z.infer<typeof TemplateListSchema>> {
  const orgId = await templateCollectionOrg(ctx, auth, query.orgId);
  await syncBakedTemplates(ctx);
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
    ...(query.q ? { q: query.q } : {}),
    limit: query.limit + 1,
    cursor,
    mode: modeOf(auth),
    passOrgId:
      (auth?.kind === 'api_key' && auth.orgId === null) || (orgId === null && isPlatformAdmin(auth))
        ? undefined
        : orgId,
  });
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  return {
    items: page.map((r) => summaryOf(r, r.passCount, r.orgName)),
    nextCursor: rows.length > query.limit && last ? `${last.createdAt}:${last.id}` : null,
  };
}

export async function detail(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  orgId?: string,
): Promise<Detail> {
  const row = await loadTemplate(ctx, auth, id, orgId);
  const passOrgId = passUsageOrg(auth, row.orgId, orgId);
  const [versions, counts] = await Promise.all([
    listVersions(ctx.env.DB, id),
    countPassesByVersion(ctx.env.DB, id, modeOf(auth), passOrgId),
  ]);
  const active = versions.find((v) => v.version === row.activeVersion);
  const display = active ?? (row.activeVersion === null ? versions[0] : undefined);
  if (!display) throw new NotFoundError('Template has no saved version.', 'TEMPLATE_NOT_FOUND');
  let total = 0;
  for (const n of counts.values()) total += n;
  const { older, settled } =
    passOrgId === null
      ? { older: 0, settled: false }
      : passOrgId === undefined
        ? await olderLivePasses(ctx.env.DB, id, modeOf(auth))
        : await olderLivePassesForOrg(ctx.env.DB, id, modeOf(auth), passOrgId);
  return {
    ...summaryOf(
      row,
      total,
      row.orgId ? ((await getOrgName(ctx.env.DB, row.orgId))?.name ?? null) : null,
    ),
    inputSchema: display.manifest.inputs as Json,
    sample: display.manifest.sample,
    manifest: display.manifest as unknown as Json,
    versions: versions.map((v) => versionDto(v, active, counts.get(v.version) ?? 0)),
    passesOnOlderVersions: older,
    passesBlocked: settled ? older : 0,
    restorable:
      row.status === 'archived' &&
      row.origin === 'uploaded' &&
      !(await hasApprovedLiveHead(ctx.env.DB, id)),
  };
}

export async function versionDetail(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  version: string,
  orgId?: string,
): Promise<VersionDetail> {
  const row = await loadTemplate(ctx, auth, id, orgId);
  const v = await getVersion(ctx.env.DB, id, version);
  if (!v) throw new NotFoundError('Template version not found.', 'TEMPLATE_VERSION_NOT_FOUND');
  const active =
    row.activeVersion === v.version
      ? v
      : row.activeVersion
        ? await getVersion(ctx.env.DB, id, row.activeVersion)
        : null;
  const counts = await countPassesByVersion(
    ctx.env.DB,
    id,
    modeOf(auth),
    passUsageOrg(auth, row.orgId, orgId),
  );
  return {
    ...versionDto(v, active ?? undefined, counts.get(v.version) ?? 0),
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
  orgId?: string,
): Promise<AssetStream> {
  await loadTemplate(ctx, auth, id, orgId);
  const registry = createTemplateRegistry(ctx.env, { ctx });
  const template = await registry.resolve(id, version);
  const entry = template.assets.find((a) => a.name === name);
  const contentType = TYPES[name.split('.').pop() ?? ''] ?? 'application/octet-stream';
  if (entry)
    return { stream: await registry.openAsset(template, name), contentType, sha1: entry.sha1 };
  return { stream: await registry.openExtra(template, name), contentType, sha1: null };
}

export async function recentUploads(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  query: { orgId?: string | undefined; limit: number },
): Promise<z.infer<typeof UploadListSchema>> {
  const orgId = await templateCollectionOrg(ctx, auth, query.orgId);
  const items = await listRecentImports(ctx.env.DB, {
    orgId,
    includeGlobal: auth?.kind === 'api_key',
    limit: query.limit,
  });
  return { items };
}

export async function importStatus(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  uploadId: string,
  orgId?: string,
): Promise<z.infer<typeof ImportStatusSchema>> {
  requireTemplateReader(auth);
  if (orgId && auth.kind === 'api_key') assertOrgAccess(auth, orgId);
  const row = await getImport(ctx.env.DB, uploadId);
  const notFound = () => new NotFoundError('Upload not found.', 'UPLOAD_NOT_FOUND');
  if (!row) throw notFound();
  if (orgId && row.orgId !== orgId) throw notFound();
  if (row.orgId) await requireTemplateOrgRead(ctx, auth, row.orgId, notFound);
  else if (auth.kind === 'session' && !auth.roles.includes('admin')) throw notFound();
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
