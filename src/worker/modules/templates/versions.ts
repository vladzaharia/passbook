import type { z } from 'zod';
import type { TemplateManifest, ValidationIssue } from '../../../passkit/types.ts';
import type {
  SaveVersionResponseSchema,
  SaveVersionSchema,
} from '../../../shared/contracts/index.ts';
import type { AuthContext } from '../../platform/auth.ts';
import { baseUrl } from '../../platform/env.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { withBackContacts } from '../passes/contacts.ts';
import { behaviors, previewPass } from './build-check.ts';
import { dryRunReport, dryRunTemplate } from './dry-run-report.ts';
import { imagesFromBinding } from './images-binding.ts';
import { audit, storageOrg } from './mutations.ts';
import { analyzePackage } from './package/analyze.ts';
import type { ImageTools } from './package/images.ts';
import { commitVersion } from './persist.ts';
import { clearTemplateCache, r2Key } from './registry.ts';
import { getOrgName, getVersion } from './repo.ts';
import { detail, loadTemplate } from './service.ts';
import { resolveVersionFiles } from './version-files.ts';

type Body = z.infer<typeof SaveVersionSchema>;
type Response = z.infer<typeof SaveVersionResponseSchema>;

const encoder = new TextEncoder();

const toIssues = (issues: ValidationIssue[]) =>
  issues
    .filter((i) => i.severity === 'error')
    .map((i) => ({ path: i.path ?? '', message: i.message, code: i.code }));

/**
 * Validates a version written from JSON (the designer) with the upload pipeline's own steps:
 * package analysis with image checks, the dry-run build, then the same commit. With `dryRun` it
 * stores nothing and returns the report and the built pass for the live preview.
 */
export async function saveVersion(
  ctx: ServiceContext,
  auth: AuthContext | undefined,
  id: string,
  body: Body,
  images: ImageTools = imagesFromBinding(ctx.env.IMAGES, ctx.log),
): Promise<Response> {
  const row = await loadTemplate(ctx, auth, id);
  if (row.origin === 'baked')
    throw new ForbiddenError(
      'Baked templates cannot be changed. Duplicate it first.',
      'TEMPLATE_BAKED',
    );
  if (row.status !== 'active')
    throw new ConflictError('Archived templates cannot be changed.', 'TEMPLATE_ARCHIVED');

  const { files, carried } = await resolveVersionFiles(ctx, id, body.assets);
  const manifest = body.manifest as unknown as TemplateManifest;
  const input = new Map(files);
  input.set('pass.json', encoder.encode(JSON.stringify(body.passJson)));
  input.set('wallet.template.json', encoder.encode(JSON.stringify(manifest)));
  const analysis = await analyzePackage(input, {
    uploaded: true,
    fallbackName: row.name,
    images,
    behaviors,
  });
  if (!('version' in analysis)) return rejected(body, analysis.report, null);

  const report = await dryRunReport(ctx, row.orgId, analysis, async (name) => {
    const bytes = analysis.files.get(name);
    if (!bytes) throw new Error(`Missing file ${name}`);
    return bytes;
  });
  if (!report.ok) return rejected(body, report, analysis);

  const org = row.orgId ? await getOrgName(ctx.env.DB, row.orgId) : null;
  const preview = previewPass(
    ctx.env,
    dryRunTemplate(row.orgId, analysis),
    analysis.manifest.sample,
    org?.name ?? 'Organization',
    new Date(ctx.clock.now()),
  );
  const built = withBackContacts(preview.passJson, {
    contact: null,
    passService: baseUrl(ctx.env),
  }) as unknown as Record<string, unknown>;
  const base = {
    version: analysis.version,
    report,
    assets: analysis.assets.map((a) => ({ ...a })),
    passJson: built,
  };
  const existing = await getVersion(ctx.env.DB, id, analysis.version);
  if (body.dryRun)
    return { ...base, saved: false, created: !existing, activated: false, template: null };

  const owner = await storageOrg(ctx, row);
  const assets = [];
  for (const a of analysis.assets) {
    const keep = carried.get(a.name);
    if (keep && keep.sha1 === a.sha1) {
      assets.push({ ...a, source: keep.source });
      continue;
    }
    const key = r2Key(owner, id, analysis.version, a.name);
    await ctx.env.BUCKET.put(key, analysis.files.get(a.name) as Uint8Array);
    assets.push({ ...a, source: { kind: 'r2' as const, key } });
  }
  await commitVersion(ctx, {
    plan: { templateId: id, isNew: false, existing: row },
    orgId: row.orgId,
    slug: row.slug,
    name: analysis.manifest.name,
    description: analysis.manifest.description ?? null,
    createdBy: auth?.kind === 'session' ? auth.userId : null,
    activate: body.activate,
    body: {
      version: analysis.version,
      manifest: analysis.manifest,
      passJson: analysis.passJson,
      assets,
      report,
      styles: analysis.styles,
    },
  });
  clearTemplateCache(ctx.env, id);
  await audit(ctx, auth, row, 'template.version', {
    version: analysis.version,
    activated: body.activate,
  });
  return {
    ...base,
    saved: true,
    created: !existing,
    activated: body.activate,
    template: await detail(ctx, auth, id),
  };
}

function rejected(
  body: Body,
  report: Response['report'],
  analysis: { version: string; assets: Response['assets'] } | null,
): Response {
  if (!body.dryRun)
    throw new ValidationError(
      'The template is invalid.',
      toIssues(report.issues),
      'VERSION_INVALID',
    );
  return {
    saved: false,
    version: analysis?.version ?? null,
    created: false,
    activated: false,
    report,
    assets: analysis?.assets ?? [],
    passJson: null,
    template: null,
  };
}
