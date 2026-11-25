import type { PaperDesign } from '../../../passkit/template/paper.ts';
import type { PaperContent } from '../../../passkit/template/paper-content.ts';
import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { existingChannels } from '../channels/door.ts';
import { passChannels } from '../channels/service.ts';
import type { Pass } from '../passes/repo-map.ts';
import { getOrg } from '../passes/repo-read-issuance.ts';
import { assertPassSnapshot, capturePassSnapshot } from '../public/snapshot.ts';
import { printCodeOf } from './codes.ts';
import { type PaperFiles, paperTicket } from './paper.ts';
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
      /** When the print was made, epoch ms. */
      printedAt: number;
      /** The print code. It goes into the page's markup and nowhere else. */
      code: string;
      generation: number;
      printId: string;
      /** The pass changed after this print was made. */
      stale: boolean;
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
): Promise<PrintPageModel> {
  if (pass.status !== 'active' || pass.removedAt !== null || pass.deletedAt !== null)
    throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const snapshot = audience === 'holder' ? await capturePassSnapshot(ctx, pass) : null;
  const [channels, existing, org, ticket] = await Promise.all([
    passChannels(ctx, pass),
    existingChannels(ctx, pass),
    getOrg(ctx.env.DB, pass.orgId),
    paperTicket(ctx, pass),
  ]);
  const base = { orgName: org?.name ?? '', mode: pass.mode };
  let model: PrintPageModel = { ...base, state: 'unavailable' };
  // A printed ticket stays viewable after a downgrade (the plan is set aside); a new one is not offered.
  if (existing.paper.on && ticket && (audience === 'staff' || ticket.design.holder)) {
    const print = await repo.activePrint(ctx.env.DB, pass.id);
    model = print
      ? {
          ...base,
          state: 'ready',
          design: ticket.design,
          content: ticket.content,
          files: ticket.files,
          printedAt: print.createdAt,
          generation: print.generation,
          printId: print.id,
          stale: print.stale,
          code: await printCodeOf(ctx.env, {
            id: print.id,
            passId: pass.id,
            orgId: pass.orgId,
            mode: pass.mode,
          }),
        }
      : channels.effective.paper.on
        ? { ...base, state: 'empty', again: await repo.endedWithPass(ctx.env.DB, pass.id) }
        : model;
  }
  if (snapshot) await assertPassSnapshot(ctx, snapshot);
  return model;
}
