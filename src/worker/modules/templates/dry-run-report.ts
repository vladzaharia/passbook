import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationIssue,
  ValidationReport,
} from '../../../passkit/types.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dryRun } from './build-check.ts';
import type { Analysis } from './package/analyze.ts';
import { stylesOf } from './package/slots.ts';
import { getOrgName } from './repo.ts';

type Analyzed = Pick<Analysis, 'manifest' | 'passJson' | 'report'> & {
  version: string;
  assets: Omit<AssetEntry, 'source'>[];
};

const key = (i: ValidationIssue) => `${i.code}|${i.path ?? ''}|${i.message}`;

/** The template a dry run builds from an analysis (inline assets). Shared by uploads and the designer. */
export function dryRunTemplate(orgId: string | null, a: Analyzed): ResolvedTemplate {
  return {
    id: 'dry-run',
    version: a.version,
    orgId,
    origin: 'uploaded',
    manifest: a.manifest as TemplateManifest,
    passJson: a.passJson as PassJson,
    assets: a.assets.map((x): AssetEntry => ({ ...x, source: { kind: 'inline' } })),
    styles: stylesOf(a.passJson) as PassStyle[],
  };
}

/** Analysis issues plus the dry-run build's, without duplicates. */
export async function dryRunReport(
  ctx: ServiceContext,
  orgId: string | null,
  a: Analyzed,
  readAsset: (name: string) => Promise<Uint8Array>,
): Promise<ValidationReport> {
  const org = orgId ? await getOrgName(ctx.env.DB, orgId) : null;
  const issues = await dryRun(
    ctx.env,
    dryRunTemplate(orgId, a),
    readAsset,
    org?.name ?? 'Organization',
    new Date(ctx.clock.now()),
    ctx.log,
  );
  const known = new Set(a.report.issues.map(key));
  const merged = [...a.report.issues, ...issues.filter((i) => !known.has(key(i)))];
  return { ok: !merged.some((i) => i.severity === 'error'), issues: merged };
}
