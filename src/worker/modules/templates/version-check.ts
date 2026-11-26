import type { z } from 'zod';
import type { TemplateManifest, ValidationIssue } from '../../../passkit/types.ts';
import type {
  SaveVersionResponseSchema,
  SaveVersionSchema,
} from '../../../shared/contracts/index.ts';
import { ValidationError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { appliedBranding, readBranding, tenantPassJson } from '../passes/branding.ts';
import { withBackContacts } from '../passes/contacts.ts';
import { getOrg as getPassOrg } from '../passes/repo-read-issuance.ts';
import { getOrgSettings } from '../settings/service.ts';
import { behaviors, defaultPassIdentity, previewPass } from './build-check.ts';
import { dryRunReport, dryRunTemplate } from './dry-run-report.ts';
import { type Analysis, analyzePackage } from './package/analyze.ts';
import type { ImageTools } from './package/images.ts';
import { getOrgName } from './repo.ts';
import { stampsForSave } from './stamps-save.ts';
import { type ForkFiles, resolveVersionFiles } from './version-files.ts';

type Body = Pick<z.infer<typeof SaveVersionSchema>, 'passJson' | 'manifest' | 'assets'>;
export type VersionResponse = z.infer<typeof SaveVersionResponseSchema>;

export interface CheckedVersion {
  analysis: Analysis;
  report: VersionResponse['report'];
  carried: Awaited<ReturnType<typeof resolveVersionFiles>>['carried'];
  /** The response fields every outcome shares: version, report, files and the built pass. */
  base: Pick<VersionResponse, 'version' | 'report' | 'assets' | 'passJson'>;
}

export interface RefusedVersion {
  report: VersionResponse['report'];
  analysis: { version: string; assets: VersionResponse['assets'] } | null;
}

const encoder = new TextEncoder();

/**
 * Validates a version written from JSON (the designer) with the upload pipeline's own steps:
 * package analysis with image checks, then the dry-run build for `orgId`. `source` is the template
 * whose stored files the body may name by hash. `stamps.carry` off draws every strip (a new
 * template cannot carry another's). `lineage` (server-derived, from the fork row) also lets the body
 * name files of the fork's upstream by hash.
 */
export async function checkVersion(
  ctx: ServiceContext,
  source: { id: string; name: string },
  orgId: string | null,
  body: Body,
  images: ImageTools,
  stamps: { dryRun: boolean; carry?: boolean },
  lineage?: ForkFiles,
): Promise<CheckedVersion | { refused: RefusedVersion }> {
  // tooling.json of an uploaded version is not carried into designer versions; it only serves the import pipeline.
  const { files, carried } = await resolveVersionFiles(ctx, source.id, body.assets, lineage);
  const manifest = body.manifest as unknown as TemplateManifest;
  const input = new Map(files);
  input.set('pass.json', encoder.encode(JSON.stringify(body.passJson)));
  input.set('wallet.template.json', encoder.encode(JSON.stringify(manifest)));
  const analysis = await analyzePackage(input, {
    uploaded: true,
    fallbackName: source.name,
    images,
    behaviors,
    stamps: stampsForSave(
      ctx,
      source.id,
      manifest,
      stamps.dryRun,
      carried,
      stamps.carry,
      lineage?.upstreamId,
    ),
  });
  if (!('version' in analysis)) return { refused: { report: analysis.report, analysis: null } };

  const report = await dryRunReport(ctx, orgId, analysis, async (name) => {
    const bytes = analysis.files.get(name);
    if (!bytes) throw new Error(`Missing file ${name}`);
    return bytes;
  });
  if (!report.ok) return { refused: { report, analysis } };

  const org = orgId ? await getOrgName(ctx.env.DB, orgId) : null;
  const preview = previewPass(
    ctx.env,
    dryRunTemplate(orgId, analysis),
    analysis.manifest.sample,
    org?.name ?? 'Organization',
    new Date(ctx.clock.now()),
    orgId ? (await getOrgSettings(ctx, orgId))['org.timeZone'] : undefined,
    await defaultPassIdentity(ctx.env),
  );
  // The organization's colours and name apply as they do in a build, unless the manifest keeps its own.
  const tenant = orgId ? await getPassOrg(ctx.env.DB, orgId) : null;
  const shown = tenant
    ? tenantPassJson(
        preview.passJson,
        tenant.name,
        appliedBranding(readBranding(tenant.branding), analysis.manifest),
        tenant.personal,
      )
    : preview.passJson;
  const built = withBackContacts(shown, {
    contact: null,
    passService: null,
  }) as unknown as Record<string, unknown>;
  return {
    analysis,
    report,
    carried,
    base: {
      version: analysis.version,
      report,
      assets: analysis.assets.map((a) => ({ ...a })),
      passJson: built,
    },
  };
}

const toIssues = (issues: ValidationIssue[]) =>
  issues
    .filter((i) => i.severity === 'error')
    .map((i) => ({ path: i.path ?? '', message: i.message, code: i.code }));

/** A dry run answers with the refusal; a save throws it. */
export function refusedResponse(dryRun: boolean, refused: RefusedVersion): VersionResponse {
  if (!dryRun)
    throw new ValidationError(
      'The template is invalid.',
      toIssues(refused.report.issues),
      'VERSION_INVALID',
    );
  return {
    saved: false,
    version: refused.analysis?.version ?? null,
    created: false,
    displayOnly: false,
    report: refused.report,
    assets: refused.analysis?.assets ?? [],
    passJson: null,
    template: null,
  };
}
