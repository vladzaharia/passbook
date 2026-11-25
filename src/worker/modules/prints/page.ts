import type { PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import type { OrgBrand } from '../../../shared/contracts/brand.ts';
import type { BrandMark } from '../../../shared/contracts/orgs.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { existingChannels } from '../channels/door.ts';
import { passChannels } from '../channels/service.ts';
import { orgBrandOf } from '../orgs/brand.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { assertPassSnapshot, capturePassSnapshot } from '../public/snapshot.ts';
import { printCodeOf } from './codes.ts';
import { type PaperFiles, paperTicket } from './paper.ts';
import { paperHash } from './paper-hash.ts';
import { loadPhoto } from './pdf-images.ts';
import * as repo from './repo.ts';

export type PrintAudience = 'holder' | 'staff';

export type PrintPageModel = { orgName: string; mode: Pass['mode'] } & (
  | { state: 'unavailable' }
  /** `again`: the earlier print ended with the pass, so a new one is needed. */
  | { state: 'empty'; again: boolean }
  | {
      state: 'ready';
      design: PaperDesign;
      content: PaperContent;
      /** Image files of the template the sheet draws. */
      files: PaperFiles;
      /** The holder's photo as a `data:` URL, for a badge or ID; the page is private and never cached. */
      photo?: string;
      /** When the print was made, epoch ms. */
      printedAt: number;
      /** The print code. It goes into the page's markup and nowhere else. */
      code: string;
      generation: number;
      printId: string;
      /** The pass draws something else than this print did. */
      stale: boolean;
      /** Hash of what the page draws now; a refresh stores it on the print. */
      paperHash: string;
      /** The org's footer choice. */
      mark: BrandMark;
    }
);

/**
 * What the print page shows for a pass: the active print's ticket, nothing yet (the holder makes it
 * with a POST) or "unavailable" when paper is off for the pass or, for a holder, staff-only. A GET
 * never mints. The snapshot fence drops the page when the link or credential moved under it.
 */
export async function printPageModel(
  ctx: ServiceContext,
  pass: Pass,
  audience: PrintAudience,
  /** The org's brand when the caller has read it already (one read per request). */
  known?: OrgBrand,
  /** The page draws the photo from a `data:` URL; the PDF and a bulk job read the bytes themselves. */
  withPhoto = false,
): Promise<PrintPageModel> {
  if (pass.status !== 'active' || pass.removedAt !== null || pass.deletedAt !== null)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const snapshot = audience === 'holder' ? await capturePassSnapshot(ctx, pass) : null;
  const [channels, existing, org, ticket, brand] = await Promise.all([
    passChannels(ctx, pass),
    existingChannels(ctx, pass),
    getOrg(ctx.env.DB, pass.orgId),
    paperTicket(ctx, pass, audience),
    known ?? orgBrandOf(ctx, pass.orgId),
  ]);
  const base = { orgName: org?.name ?? '', mode: pass.mode };
  let model: PrintPageModel = { ...base, state: 'unavailable' };
  // A printed ticket stays viewable after a downgrade (the plan is set aside); a new one is not offered.
  if (existing.paper.on && ticket && (audience === 'staff' || ticket.design.holder)) {
    const hash = await paperHash(ticket);
    const print = await repo.activePrint(ctx.env.DB, pass.id, hash);
    model = print
      ? {
          ...base,
          state: 'ready',
          design: ticket.design,
          content: ticket.content,
          files: ticket.files,
          ...(withPhoto ? await photoUrl(ctx, pass, ticket.files, audience) : {}),
          printedAt: print.createdAt,
          generation: print.generation,
          printId: print.id,
          stale: print.stale,
          paperHash: hash,
          mark: brand.mark,
          code: await printCodeOf(ctx.env, {
            id: print.id,
            passId: pass.id,
            orgId: pass.orgId,
            mode: pass.mode,
          }),
        }
      : channels.effective.paper.on
        ? { ...base, state: 'empty', again: await repo.endedForHolder(ctx.env.DB, pass.id) }
        : model;
  }
  if (snapshot) await assertPassSnapshot(ctx, snapshot);
  return model;
}

const base64 = (bytes: Uint8Array): string => {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
};

async function photoUrl(
  ctx: ServiceContext,
  pass: Pass,
  files: PaperFiles,
  audience: PrintAudience,
): Promise<{ photo?: string }> {
  if (!files.photo) return {};
  const photo = await loadPhoto(ctx, pass, audience);
  return photo ? { photo: `data:image/png;base64,${base64(photo.bytes)}` } : {};
}
