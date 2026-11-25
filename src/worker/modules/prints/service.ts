import type { MintedPrint, PassPrint, PrintVoidCause } from '../../../shared/contracts/prints.ts';
import { featureNotIncluded } from '../../../shared/copy/entitlements.ts';
import { bump } from '../../platform/counters.ts';
import {
  ConflictError,
  FeatureNotIncludedError,
  NotFoundError,
  RateLimitedError,
} from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { existingChannels } from '../channels/door.ts';
import { passChannels } from '../channels/service.ts';
import { recordPassEvents } from '../events/record.ts';
import type { Pass } from '../passes/repo-map.ts';
import { printCodeOf, printCodeRef, printRosterHash } from './codes.ts';
import { paperTicket } from './paper.ts';
import { paperHash } from './paper-hash.ts';
import { dropPrintPdfs } from './pdf-drop.ts';
import * as repo from './repo.ts';
import { type PrintWriter, writeMint, writeRefresh, writeVoid } from './repo-write.ts';

const HOUR = 3_600_000;
const PRINT_UNAVAILABLE = 'Printing is not available for this ticket.';
/** Print changes a holder may make per pass per hour (mint, reprint and void count alike). */
export const HOLDER_PRINTS_PER_HOUR = 3;
/** The same window for staff and keys, who print in bulk at an event. */
export const ADMIN_PRINTS_PER_HOUR = 30;

export interface PrintCaller {
  writer: PrintWriter;
  limit: number;
}

const codeOf = (ctx: ServiceContext, pass: Pass, print: PassPrint): Promise<string> =>
  printCodeOf(ctx.env, { id: print.id, passId: pass.id, orgId: pass.orgId, mode: pass.mode });

/** Spends one change of the hour's allowance; the increment is the check, so concurrent calls cannot overshoot. */
async function spend(ctx: ServiceContext, pass: Pass, limit: number): Promise<void> {
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  if ((await bump(ctx.env.DB, `prints:${pass.id}`, window)) > limit)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));
}

/**
 * Mints a print. With `replace` an active print is voided as `replaced` first (a reprint); without it an
 * active print is returned as it is (the holder's first use). Needs the paper channel on for the pass.
 */
export async function mintPrint(
  ctx: ServiceContext,
  caller: PrintCaller,
  pass: Pass,
  replace: boolean,
): Promise<MintedPrint> {
  if (pass.status !== 'active' || pass.removedAt !== null)
    throw new ConflictError('Only an active pass can be printed.', 'PASS_NOT_ACTIVE');
  // The plan is set aside for what is already printed: a holder's first use returns the ticket they have.
  if (!(await existingChannels(ctx, pass)).paper.on)
    throw new ConflictError('Printing is off for this ticket.', 'PRINTING_OFF');
  const existing = await repo.activePrint(ctx.env.DB, pass.id);
  if (existing && !replace) {
    // The holder or staff opens the print again: it is drawn from the pass as it is now.
    await refreshActivePrint(ctx, caller.writer, pass);
    return { ...existing, stale: false, code: await codeOf(ctx, pass, existing) };
  }
  // A new print needs the plan; the holder is not told to ask PassBook.
  if ((await passChannels(ctx, pass)).effective.paper.reason === 'not_included')
    throw new FeatureNotIncludedError(
      'print',
      caller.writer.by === 'holder' ? PRINT_UNAVAILABLE : featureNotIncluded('print'),
    );
  await spend(ctx, pass, caller.limit);
  const id = ctx.ids.id();
  const generation = await repo.nextGeneration(ctx.env.DB, pass.id);
  const code = await printCodeOf(ctx.env, {
    id,
    passId: pass.id,
    orgId: pass.orgId,
    mode: pass.mode,
  });
  const codeHash = await printCodeRef(ctx.env, pass.orgId, pass.mode, code);
  if (!codeHash) throw new ConflictError('Print codes are unavailable.', 'PRINT_CODE_UNAVAILABLE');
  const ticket = await paperTicket(ctx, pass);
  const voided = await writeMint(
    ctx,
    caller.writer,
    pass.id,
    {
      id,
      codeHash,
      rosterHash: await printRosterHash(code),
      generation,
      passVersion: pass.version,
      paperHash: ticket ? await paperHash(ticket) : null,
    },
    replace,
  );
  if (existing && voided > 0) await dropPrintPdfs(ctx, pass, existing.id);
  await recordPassEvents(ctx, [
    {
      orgId: pass.orgId,
      passId: pass.id,
      mode: pass.mode,
      kind: 'pass.printed',
      actor: null,
      data: { printId: id, generation, ...(voided > 0 ? { voided } : {}) },
    },
  ]);
  const print = await repo.printById(ctx.env.DB, pass.id, id);
  if (!print) throw new ConflictError('The print was not saved.', 'PRINT_CONFLICT');
  return { ...print, code };
}

/** Voids the named print, or the active one when no id is given. */
export async function voidPrint(
  ctx: ServiceContext,
  caller: PrintCaller,
  pass: Pass,
  cause: PrintVoidCause,
  printId?: string,
): Promise<PassPrint> {
  const target = printId
    ? await repo.printById(ctx.env.DB, pass.id, printId)
    : await repo.activePrint(ctx.env.DB, pass.id);
  if (!target) throw new NotFoundError('Print not found.', 'PRINT_NOT_FOUND');
  if (target.status !== 'active')
    throw new ConflictError('This print is already voided.', 'PRINT_NOT_ACTIVE');
  await spend(ctx, pass, caller.limit);
  await writeVoid(ctx, caller.writer, pass.id, cause, target.id);
  await dropPrintPdfs(ctx, pass, target.id);
  return (await repo.printById(ctx.env.DB, pass.id, target.id)) ?? target;
}

/** The pass's prints, newest first; the active one is stale when the pass now draws something else. */
export async function listPassPrints(ctx: ServiceContext, pass: Pass): Promise<PassPrint[]> {
  const ticket = await paperTicket(ctx, pass);
  return repo.listPrints(ctx.env.DB, pass.id, ticket ? await paperHash(ticket) : null);
}

/**
 * The active print was drawn again (the page's Print, a PDF, a bulk render): it now matches the pass as it
 * is. Returns the print, or null when there is none or the pass cannot be drawn.
 */
export async function refreshActivePrint(
  ctx: ServiceContext,
  writer: PrintWriter,
  pass: Pass,
): Promise<PassPrint | null> {
  const ticket = await paperTicket(ctx, pass);
  const active = await repo.activePrint(ctx.env.DB, pass.id);
  if (!ticket || !active) return null;
  const hash = await paperHash(ticket);
  await writeRefresh(ctx, writer, pass.id, active.id, pass.version, hash);
  return repo.activePrint(ctx.env.DB, pass.id, hash);
}
