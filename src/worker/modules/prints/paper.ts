import { type PaperDesign, resolvePaper } from '../../../passkit/template/paper.ts';
import { type PaperContent, paperContent } from '../../../passkit/template/paper-content.ts';
import type { AssetEntry, PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import type { Pass } from '../passes/repo-map.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import * as repo from './repo.ts';

/** The paper design of the pass's pinned template version; derived when it has no `paper` block. */
export async function paperDesign(ctx: ServiceContext, pass: Pass): Promise<PaperDesign> {
  const manifest = await repo.manifestOf(ctx.env.DB, pass.templateId, pass.templateVersion);
  return resolvePaper(manifest?.paper);
}

/** `paper.holder: false` keeps printing with staff: the holder's link neither prints nor reprints nor voids. */
export async function assertHolderMayPrint(ctx: ServiceContext, pass: Pass): Promise<void> {
  if (!(await paperDesign(ctx, pass)).holder)
    throw new ForbiddenError('Printing is available from the organizer.', 'PRINT_STAFF_ONLY');
}

/** Image files the ticket draws, by file name: the template's logo and the art slot its content names. */
export interface PaperFiles {
  logo?: string;
  art?: string;
}

/** The art slots a paper band can use; `strip` is the coupon's, the others the pass's own. */
const SLOT_NAMES = ['logo', 'artwork', 'background', 'thumbnail', 'strip'];

function bestFile(assets: AssetEntry[], slot: string): string | undefined {
  const own = assets.filter((a) => (a.slot as string) === slot && !a.locale && !a.stamps);
  return own.sort((a, b) => b.scale - a.scale)[0]?.name;
}

/** The ticket's words for this pass, from its stored pass.json at the current version. */
export async function paperTicket(
  ctx: ServiceContext,
  pass: Pass,
): Promise<{ design: PaperDesign; content: PaperContent; files: PaperFiles } | null> {
  const [manifest, raw, template] = await Promise.all([
    repo.manifestOf(ctx.env.DB, pass.templateId, pass.templateVersion),
    passJsonAtVersion(ctx.env.DB, pass.id, pass.version),
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
  ]);
  if (!raw) return null;
  const passJson: PassJson = parseStoredPassJson(raw);
  const design = resolvePaper(manifest?.paper);
  const images = SLOT_NAMES.filter((slot) => bestFile(template.assets, slot));
  const content = paperContent({
    passJson,
    manifest: (manifest ?? {}) as Pick<
      TemplateManifest,
      'wallets' | 'inputs' | 'lookups' | 'scan' | 'display' | 'name'
    >,
    personalization: pass.personalization,
    scanCode: pass.scanCode,
    design,
    images,
  });
  const logo = bestFile(template.assets, 'logo');
  const art = content.art ? bestFile(template.assets, content.art) : undefined;
  return { design, content, files: { ...(logo ? { logo } : {}), ...(art ? { art } : {}) } };
}
