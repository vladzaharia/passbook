import {
  holderMayPrint,
  type PaperDesign,
  resolvePaper,
  withKind,
} from '../../../passkit/template/paper.ts';
import { bestImage, imageSlots } from '../../../passkit/template/paper-assets.ts';
import { type PaperContent, paperContent } from '../../../passkit/template/paper-content.ts';
import { forAudience } from '../../../passkit/template/paper-region.ts';
import type { PassJson, TemplateManifest } from '../../../passkit/types.ts';
import { ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { resolveTemplate } from '../passes/builder.ts';
import { parseStoredPassJson } from '../passes/detail.ts';
import type { Pass } from '../passes/repo-map.ts';
import { passJsonAtVersion } from '../public/repo.ts';
import { readOrgTimeZone } from '../scan/repo-org-clock.ts';
import { getOrgSettings } from '../settings/service.ts';
import * as repo from './repo.ts';

const zones = new WeakMap<ServiceContext, Map<string, Promise<string | undefined>>>();

/**
 * The org's `org.timeZone`, which picks Letter over A4 and the holder's home sheet. Read once per
 * org for a context (a bulk job builds one context for all its passes).
 */
function orgZone(ctx: ServiceContext, orgId: string): Promise<string | undefined> {
  const byOrg = zones.get(ctx) ?? new Map<string, Promise<string | undefined>>();
  zones.set(ctx, byOrg);
  let hit = byOrg.get(orgId);
  if (!hit) {
    hit = getOrgSettings(ctx, orgId).then((s) => s['org.timeZone']);
    byOrg.set(orgId, hit);
  }
  return hit;
}

/** `paper.holder: false` keeps printing with staff: the holder's link neither prints nor reprints nor voids. */
export async function assertHolderMayPrint(ctx: ServiceContext, pass: Pass): Promise<void> {
  const manifest = await repo.manifestOf(ctx.env.DB, pass.templateId, pass.templateVersion);
  if (!holderMayPrint(manifest))
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
  audience: 'holder' | 'staff',
): Promise<{ design: PaperDesign; content: PaperContent; files: PaperFiles } | null> {
  const [manifest, raw, template, zone] = await Promise.all([
    repo.manifestOf(ctx.env.DB, pass.templateId, pass.templateVersion),
    passJsonAtVersion(ctx.env.DB, pass.id, pass.version),
    resolveTemplate(ctx, pass.orgId, pass.templateId, pass.templateVersion),
    orgZone(ctx, pass.orgId),
  ]);
  if (!raw) return null;
  const passJson: PassJson = parseStoredPassJson(raw);
  // A holder prints at home (the region's sheet); staff print the exact page.
  const base = forAudience(resolvePaper(manifest?.paper), audience, zone);
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
