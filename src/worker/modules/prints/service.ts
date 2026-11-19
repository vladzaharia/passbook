import type { MintedPrint, PassPrint, PrintVoidCause } from '../../../shared/contracts/prints.ts';
import { bump, read } from '../../platform/counters.ts';
import { ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { passChannels } from '../channels/service.ts';
import { recordPassEvents } from '../events/record.ts';
import type { Pass } from '../passes/repo-map.ts';
import { printCodeOf, printCodeRef, printRosterHash } from './codes.ts';
import * as repo from './repo.ts';
import { type PrintWriter, writeMint, writeVoid } from './repo-write.ts';

const HOUR = 3_600_000;
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

async function checkRate(ctx: ServiceContext, pass: Pass, limit: number) {
  const now = ctx.clock.now();
  const window = now - (now % HOUR);
  const key = `prints:${pass.id}`;
  if ((await read(ctx.env.DB, key, window)) >= limit)
    throw new RateLimitedError(Math.ceil((window + HOUR - now) / 1000));
  return () => bump(ctx.env.DB, key, window);
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
  const existing = await repo.activePrint(ctx.env.DB, pass.id);
  if (existing && !replace) return { ...existing, code: await codeOf(ctx, pass, existing) };
  if (!(await passChannels(ctx, pass)).effective.paper.on)
    throw new ConflictError('Printing is off for this ticket.', 'PRINTING_OFF');
  const done = await checkRate(ctx, pass, caller.limit);
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
  const voided = await writeMint(
    ctx,
    caller.writer,
    pass.id,
    { id, codeHash, rosterHash: await printRosterHash(code), generation },
    replace,
  );
  await done();
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
  const done = await checkRate(ctx, pass, caller.limit);
  await writeVoid(ctx, caller.writer, pass.id, cause, target.id);
  await done();
  return (await repo.printById(ctx.env.DB, pass.id, target.id)) ?? target;
}
