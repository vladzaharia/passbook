import type { CreatedDeveloperSandbox, SandboxReset } from '../../../shared/contracts/developer.ts';
import { SANDBOX_KEY_NAME, SANDBOX_TEMPLATE_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { AppError, ConflictError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeApiKeys } from '../api-keys/access.ts';
import { revokeApiKey } from '../api-keys/service.ts';
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
  deleteSandboxRows,
  openSandboxKeys,
  orgHeld,
  reopenWindow,
  resetsClaimedSince,
  sandboxPasses,
  trackStartedAt,
} from './repo-reset.ts';
import { dto, mintSandboxKey } from './service.ts';

const DAY_MS = 86_400_000;
const PAGE = 25;
const MAX_PAGES = 8;

const resetsUsed = (ctx: ServiceContext, orgId: string): Promise<number> =>
  resetsClaimedSince(ctx.env.DB, orgId, RESET_ACTION, ctx.clock.now() - DAY_MS);

/** Test passes of the sandbox, a page at a time, each deleted by the same guarded statement the daily test purge uses. */
async function purgePasses(
  ctx: ServiceContext,
  orgId: string,
  userId: string,
  stamp: number,
): Promise<{ deleted: number; kept: number }> {
  const keyset = await requireCredentialRefKeyset(ctx.env.DB, ctx.env);
  let deleted = 0;
  let kept = 0;
  let after = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    // The claim is checked before every page: a close or a newer reset stops this one.
    if (!(await claimStands(ctx.env.DB, orgId, userId, stamp))) break;
    const passes = await sandboxPasses(ctx.env.DB, orgId, after, PAGE);
    for (const pass of passes) {
      if (pass.mode !== 'test') {
        kept++;
        continue;
      }
      const retention = await prepareScanRetentionDelete(ctx.env, pass);
      const removed = await deletePassRows(ctx.env.DB, pass, retention, keyset, {
        testBefore: stamp + 1,
        lifecycleGeneration: pass.lifecycleGeneration,
      });
      if (!removed.deleted) {
        kept++;
        continue;
      }
      await deleteObjects(ctx.env.BUCKET, removed.objectKeys);
      await dropPrintPdfs(ctx, pass);
      deleted++;
    }
    const last = passes.at(-1);
    if (passes.length < PAGE || !last) break;
    after = last.id;
  }
  return { deleted, kept };
}

/** Revokes the person's open sandbox keys and makes one new key; its secret is in the answer once. */
async function rollKey(ctx: ServiceContext, test: SessionAuth, orgId: string) {
  const authority = await authorizeApiKeys(ctx, test, orgId, 'org:read');
  const open = await openSandboxKeys(ctx.env.DB, orgId, test.userId, SANDBOX_KEY_NAME);
  for (const k of open) await revokeApiKey(ctx, authority, k.id);
  return mintSandboxKey(ctx, test, orgId);
}

/**
 * Resets the caller's own sandbox: the quickstart track starts again, its test passes, captured webhooks, request
 * log and idempotency records are deleted, and the sandbox key is replaced (the old one revoked, the new secret
 * shown once). Kept: the org, ticket template, capture endpoint, other keys, membership and the funnel's first
 * values. The org is always the caller's own sandbox, never a request value. At most 3 a day.
 */
export async function resetSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<SandboxReset> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at !== null)
    throw new ConflictError('The sandbox is closed. Reopen it first.', 'SANDBOX_CLOSED');
  const orgId = row.org_id;
  if (await orgHeld(ctx.env.DB, orgId))
    throw new ConflictError('A legal hold stands on this sandbox.', 'ORG_HELD');
  const used = await resetsUsed(ctx, orgId);
  if (used >= RESETS_PER_DAY) throw limited();
  const stamp = await nextStamp(ctx, orgId);
  const by = { userId: session.userId, sessionIdHash: session.sessionId };
  if (!(await restartTrack(ctx, { id: row.id, orgId }, by, stamp))) {
    // A racing reset took the last slot, or the sandbox closed between the read and the claim.
    if ((await resetsUsed(ctx, orgId)) >= RESETS_PER_DAY) throw limited();
    throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  }
  const passes = await purgePasses(ctx, orgId, session.userId, stamp);
  const captures = await deleteCaptures(ctx, { id: row.id, orgId }, session.userId, stamp);
  const rows = await deleteSandboxRows(ctx.env.DB, orgId, session.userId, stamp);
  const test: SessionAuth = { ...session, mode: 'test' };
  const key = await rollKey(ctx, test, orgId);
  return {
    sandbox: dto(row, await quickstartTemplateOf(ctx.env.DB, orgId, SANDBOX_TEMPLATE_NAME)),
    key,
    deleted: {
      passes: passes.deleted,
      captures,
      calls: rows.request_log,
    },
    kept: passes.kept,
    resetsLeft: Math.max(0, RESETS_PER_DAY - (used + 1)),
  };
}

const limited = () =>
  new AppError(
    'SANDBOX_RESET_LIMIT',
    429,
    `You can reset a sandbox ${RESETS_PER_DAY} times a day. Try again tomorrow.`,
    { headers: { 'retry-after': '3600' } },
  );

/** The track restarts strictly later than it last started (a trigger refuses otherwise), even inside one millisecond. */
const nextStamp = async (ctx: ServiceContext, orgId: string): Promise<number> =>
  Math.max(ctx.clock.now(), (await trackStartedAt(ctx.env.DB, orgId)) + 1);

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
  {
    const org = await reopenWindow(ctx.env.DB, row.org_id);
    if (!org || org.purge_started_at !== null || (org.purge_after ?? 0) < ctx.clock.now())
      throw new ConflictError('The reopen window has passed.', 'SANDBOX_REOPEN_WINDOW');
    const ok = await reopenSandbox(
      ctx,
      { id: row.id, orgId: row.org_id },
      {
        userId: session.userId,
        sessionIdHash: session.sessionId,
      },
    );
    if (!ok)
      throw new ConflictError(
        'The sandbox cannot be reopened. Ask an administrator.',
        'SANDBOX_CONFLICT',
      );
  }
  const after = await sandboxOfUser(ctx.env.DB, session.userId);
  const test: SessionAuth = { ...session, mode: 'test' };
  const key = await rollKey(ctx, test, row.org_id);
  return {
    ...dto(after ?? row, await quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME)),
    key,
    previousKey: null,
  };
}
