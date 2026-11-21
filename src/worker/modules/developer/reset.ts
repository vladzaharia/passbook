import type { CreatedDeveloperSandbox, SandboxReset } from '../../../shared/contracts/developer.ts';
import { SANDBOX_KEY_NAME, SANDBOX_TEMPLATE_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { requireCredentialRefKeyset } from '../passes/credential-keyset.ts';
import { deleteObjects, deletePassRows } from '../passes/repo-ops-retention.ts';
import { dropPrintPdfs } from '../prints/pdf-drop.ts';
import { prepareScanRetentionDelete } from '../scan/scan-retention-proof.ts';
import { quickstartTemplateOf, sandboxOfUser } from './repo.ts';
import {
  deleteCaptures,
  RESET_ACTION,
  RESETS_PER_DAY,
  reopenSandbox,
  restartTrack,
} from './repo-grants-reset.ts';
import {
  claimStands,
  closeReasonOf,
  deleteSlice,
  importObjectKeys,
  openKeyCount,
  orgHeld,
  type ResetTable,
  reopenWindow,
  resetsClaimedSince,
  SLICE_ROWS,
  sandboxPasses,
  trackStartRaw,
} from './repo-reset.ts';
import { dto, mintSandboxKey, quickstartTemplate } from './service.ts';

const DAY_MS = 86_400_000;
const PAGE = 25;
/** How long one request keeps purging before it says `more` and lets the person ask again (no slot is spent). */
const BUDGET_MS = 25_000;

const resetsUsed = (ctx: ServiceContext, orgId: string): Promise<number> =>
  resetsClaimedSince(ctx.env.DB, orgId, RESET_ACTION, ctx.clock.now() - DAY_MS);

const limited = () =>
  new AppError(
    'SANDBOX_RESET_LIMIT',
    429,
    `You can reset a sandbox ${RESETS_PER_DAY} times a day. Try again tomorrow.`,
    { headers: { 'retry-after': '3600' } },
  );

/** What one purge removed, and what it could not. */
interface Tally {
  passes: number;
  kept: number;
  captures: number;
  calls: number;
  other: number;
}

/** True when the request has used its time: the purge stops cleanly and says `more`. */
type Expired = () => boolean;

/** Test passes of the sandbox, a page at a time, each deleted by the guarded statement the daily test purge uses. */
async function purgePasses(
  ctx: ServiceContext,
  sandbox: { orgId: string },
  userId: string,
  stamp: number,
  tally: Tally,
  expired: Expired,
): Promise<boolean> {
  const keyset = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  let after = '';
  for (;;) {
    // The claim is checked before every page: a close or a newer reset stops this one.
    if (!(await claimStands(ctx.env.DB, sandbox.orgId, userId, stamp))) return true;
    const passes = await sandboxPasses(ctx.env.DB, sandbox.orgId, after, PAGE);
    for (const pass of passes) {
      if (pass.mode !== 'test') {
        tally.kept++;
        continue;
      }
      const retention = await prepareScanRetentionDelete(ctx.env, pass);
      const removed = await deletePassRows(ctx.env.DB, pass, retention, keyset, {
        testBefore: stamp + 1,
        lifecycleGeneration: pass.lifecycleGeneration,
        claim: { userId, stamp },
      });
      if (!removed.deleted) {
        tally.kept++;
        continue;
      }
      await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
      await dropPrintPdfs(ctx, pass);
      tally.passes++;
    }
    const last = passes.at(-1);
    if (passes.length < PAGE || !last) return false;
    after = last.id;
    if (expired()) return true;
  }
}

/** The rest of the Test data, table by table in slices. True when the time ran out first. */
async function purgeRows(
  ctx: ServiceContext,
  orgId: string,
  userId: string,
  stamp: number,
  tally: Tally,
  expired: Expired,
): Promise<boolean> {
  const order: [ResetTable, keyof Tally][] = [
    ['captured_emails', 'other'],
    ['bundles', 'other'],
    ['pass_imports', 'other'],
    ['broadcasts', 'other'],
    ['message_rules', 'other'],
    ['request_log', 'calls'],
    ['idempotent_requests', 'other'],
    ['idempotency_keys', 'other'],
  ];
  for (const [table, into] of order) {
    if (table === 'pass_imports') {
      const keys = await importObjectKeys(ctx.env.DB, orgId);
      if (keys.length > 0 && (await claimStands(ctx.env.DB, orgId, userId, stamp)))
        await deleteObjects(ctx.env.BUCKET, keys);
    }
    for (;;) {
      const n = await deleteSlice(ctx.env.DB, table, orgId, userId, stamp);
      tally[into] += n;
      if (n < SLICE_ROWS) break;
      if (expired()) return true;
    }
  }
  return false;
}

/** The whole purge under one claim. True when it stopped before it was done. */
async function purge(
  ctx: ServiceContext,
  sandbox: { id: string; orgId: string },
  userId: string,
  stamp: number,
  budgetMs: number,
): Promise<{ tally: Tally; more: boolean }> {
  const tally: Tally = { passes: 0, kept: 0, captures: 0, calls: 0, other: 0 };
  const until = Date.now() + budgetMs;
  const expired: Expired = () => Date.now() >= until;
  if (await purgePasses(ctx, sandbox, userId, stamp, tally, expired)) return { tally, more: true };
  if (expired()) return { tally, more: true };
  tally.captures = await deleteCaptures(ctx, sandbox, userId, stamp);
  return { tally, more: await purgeRows(ctx, sandbox.orgId, userId, stamp, tally, expired) };
}

/**
 * Resets the caller's own sandbox: the quickstart track starts again, its test passes, captured webhooks, request
 * log, bundles, imports, broadcasts, rules and idempotency records are deleted, the ticket template is released
 * again and the sandbox key is replaced. Kept: the org, capture endpoint, membership, other keys and the funnel's
 * first values. The org is always the caller's own sandbox, never a request value.
 *
 * One claim spends one of 3 daily slots, restarts the track and revokes the old key in the same batch. If the purge
 * cannot finish (time, or a fault), no key is minted yet: the next call finds the claim unfinished (a restarted
 * track and no open key) and resumes it under the same stamp without spending a slot. The new key comes last.
 */
export async function resetSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
  options: { budgetMs?: number } = {},
): Promise<SandboxReset> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at !== null)
    throw new ConflictError('The sandbox is closed. Reopen it first.', 'SANDBOX_CLOSED');
  const orgId = row.org_id;
  const sandbox = { id: row.id, orgId };
  if (await orgHeld(ctx.env.DB, orgId))
    throw new ConflictError('A legal hold stands on this sandbox.', 'ORG_HELD');
  const prev = await trackStartRaw(ctx.env.DB, orgId);
  const unfinished =
    prev !== null &&
    (await openKeyCount(ctx.env.DB, orgId, session.userId, SANDBOX_KEY_NAME)) === 0;
  let stamp: number;
  let used = await resetsUsed(ctx, orgId);
  if (unfinished && prev !== null) {
    stamp = prev;
  } else {
    if (used >= RESETS_PER_DAY) throw limited();
    stamp = Math.max(ctx.clock.now(), (prev ?? row.created_at) + 1);
    try {
      await restartTrack(
        ctx,
        sandbox,
        { userId: session.userId, sessionIdHash: session.sessionId },
        stamp,
        prev,
      );
    } catch (error) {
      if (!(error instanceof AppError) || error.code !== 'SANDBOX_CONFLICT') throw error;
      // A refused check: the last slot went to a racing reset, or the sandbox changed under us.
      if ((await resetsUsed(ctx, orgId)) >= RESETS_PER_DAY) throw limited();
      throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
    }
    used += 1;
  }
  let result: Awaited<ReturnType<typeof purge>>;
  try {
    result = await purge(ctx, sandbox, session.userId, stamp, options.budgetMs ?? BUDGET_MS);
  } catch (error) {
    ctx.log.error('developer.sandbox_reset_failed', { orgId, code: 'SANDBOX_RESET_FAILED', error });
    throw error;
  }
  const { tally, more } = result;
  ctx.log.info('developer.sandbox_reset', {
    orgId,
    deleted: {
      passes: tally.passes,
      captures: tally.captures,
      calls: tally.calls,
      other: tally.other,
    },
    kept: tally.kept,
    more,
  });
  const test: SessionAuth = { ...session, mode: 'test' };
  // The ticket is released again (made again if it was deleted); the key is minted last, so a failure above
  // leaves the person with no new secret and a retry that costs no slot.
  const templateId = more
    ? await quickstartTemplateOf(ctx.env.DB, orgId, SANDBOX_TEMPLATE_NAME)
    : await quickstartTemplate(ctx, test, orgId);
  const key = more ? null : await mintSandboxKey(ctx, test, orgId);
  return {
    sandbox: dto(row, templateId),
    key,
    deleted: {
      passes: tally.passes,
      captures: tally.captures,
      calls: tally.calls,
      other: tally.other,
    },
    kept: tally.kept,
    more,
    resetsLeft: Math.max(0, RESETS_PER_DAY - used),
  };
}

/**
 * Reopens the caller's own closed sandbox inside its 30 days, then makes a new key (closing revoked the old
 * ones). An administrator's close stays closed: only a close by the person or the idle sweep reopens here.
 */
export async function reopenOwnSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<CreatedDeveloperSandbox> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at === null)
    throw new ConflictError('The sandbox is already open.', 'SANDBOX_NOT_CLOSED');
  const org = await reopenWindow(ctx.env.DB, row.org_id);
  if (!org || org.purge_started_at !== null || (org.purge_after ?? 0) < ctx.clock.now())
    throw new ConflictError('The reopen window has passed.', 'SANDBOX_REOPEN_WINDOW');
  try {
    await reopenSandbox(
      ctx,
      { id: row.id, orgId: row.org_id },
      {
        userId: session.userId,
        sessionIdHash: session.sessionId,
      },
    );
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== 'SANDBOX_CONFLICT') throw error;
    // The in-write checks refused: an administrator's close (the person cannot undo it), else a race.
    if ((await closeReasonOf(ctx.env.DB, row.org_id)) === 'admin')
      throw new ConflictError(
        'An administrator closed this sandbox. Ask an administrator.',
        'SANDBOX_REOPEN_ADMIN',
      );
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  }
  const after = await sandboxOfUser(ctx.env.DB, session.userId);
  const test: SessionAuth = { ...session, mode: 'test' };
  const key = await mintSandboxKey(ctx, test, row.org_id);
  return {
    ...dto(after ?? row, await quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME)),
    key,
    previousKey: null,
  };
}
