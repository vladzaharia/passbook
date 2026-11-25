import { type PaperDesign, resolvePaper, withKind } from '../../../passkit/template/paper.ts';
import { bestImage, imageSlots } from '../../../passkit/template/paper-assets.ts';
import { type PaperContent, paperContent } from '../../../passkit/template/paper-content.ts';
import { kindOf } from '../../../passkit/template/paper-kinds.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import type { Pass } from '../passes/repo-map.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import * as repo from './repo.ts';

/** The paper design of the pass's pinned template version; derived when it has no `paper` block. */
export async function paperDesign(ctx: ServiceContext, pass: Pass): Promise<PaperDesign> {
  const manifest = await repo.manifestOf(ctx.env.DB, pass.templateId, pass.templateVersion);
  const design = resolvePaper(manifest?.paper);
  // No block: the class the template reads as decides who may print (an ID is staff-only).
  return manifest && design.derived ? withKind(design, kindOf(manifest, undefined, {})) : design;
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
  /** The sheet leads with the holder's photo (a badge or ID). */
  photo?: true;
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
  const base = resolvePaper(manifest?.paper);
  const images = imageSlots(template.assets);
  const content = paperContent({
    passJson,
    manifest: (manifest ?? {}) as Pick<
      TemplateManifest,
      'wallets' | 'behaviors' | 'inputs' | 'lookups' | 'scan' | 'display' | 'name' | 'bindings'
    >,
    personalization: pass.personalization,
    scanCode: pass.scanCode,
    design: base,
    images,
    orgTimeZone: await readOrgTimeZone(ctx.env.DB, pass.orgId),
  });
  const design = withKind(base, content.kind);
  const logo = bestImage(template.assets, 'logo');
  const art = content.art ? bestImage(template.assets, content.art) : undefined;
  return {
    design,
    content,
    files: {
      ...(logo ? { logo } : {}),
      ...(art ? { art } : {}),
      ...(content.photo ? { photo: true as const } : {}),
    },
  };
}
