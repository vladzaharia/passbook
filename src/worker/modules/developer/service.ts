import { SANDBOX_KEY_SCOPES } from '../../../shared/contracts/developer-home.ts';
import type { CreatedDeveloperSandbox, DeveloperSandbox } from '../../../shared/contracts/index.ts';
import { TimeZoneSchema } from '../../../shared/contracts/scan-base.ts';
import {
  SANDBOX_EXISTS_COPY,
  SANDBOX_KEY_NAME,
  SANDBOX_TEMPLATE_NAME,
} from '../../../shared/copy/developer.ts';
import { resolveOrgTimeZone } from '../../../shared/time-zone.ts';
import { isPlatformScope } from '../../platform/api-scopes.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { actorOf } from '../../platform/context.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeApiKeys } from '../api-keys/access.ts';
import { createApiKey } from '../api-keys/service-create.ts';
import { ensureSandboxTerminal } from '../scan/repo-sandbox-terminal.ts';
import { approveCandidate, publishRelease } from '../templates/releases.ts';
import { createCandidate } from '../templates/releases-create.ts';
import { useBlueprint as forkBlueprint } from '../templates/use-blueprint.ts';
import { authorizeWebhooks } from '../webhooks/access.ts';
import { ensureCapture } from '../webhooks/service-captures.ts';
import { recordSandboxMade } from './funnel.ts';
import {
  approvalOf,
  candidateOf,
  hasTestRelease,
  primaryEmailOf,
  quickstartTemplateOf,
  type SandboxRow,
  sandboxKeyOf,
  sandboxOfUser,
  ticketOf,
} from './repo.ts';
import { closeSandbox, insertSandbox } from './repo-grants.ts';

/** The quickstart's blueprint, and how long its test key lives. */
const QUICKSTART_BLUEPRINT = 'baked:starter-event-ticket';
const KEY_TTL_MS = 30 * 86_400_000;

/** A key a sandbox holds can reach everything a test org can, except minting keys, the terminal scope and the live-only scanning setup scope. */
const KEY_SCOPES = SANDBOX_KEY_SCOPES.filter((s) => !isPlatformScope(s));

/** A new Test personal key for the person (30 days): the secret is in the answer once and nowhere else. */
export async function mintSandboxKey(
  ctx: ServiceContext,
  test: SessionAuth,
  orgId: string,
): Promise<NonNullable<CreatedDeveloperSandbox['key']>> {
  const now = ctx.clock.now();
  const authority = await authorizeApiKeys(ctx, test, orgId, 'org:read');
  const key = await createApiKey(ctx, authority, {
    orgId,
    name: SANDBOX_KEY_NAME,
    kind: 'personal',
    mode: 'test',
    scopes: KEY_SCOPES,
    expiresAt: now + KEY_TTL_MS,
  });
  // A sandbox made before the terminal existed gets it when its key is made or rolled.
  await ensureSandboxTerminal(ctx, test, orgId);
  return {
    id: key.id,
    name: key.name,
    secret: key.secret,
    mode: 'test',
    expiresAt: key.expiresAt ?? now + KEY_TTL_MS,
  };
}

/** The org's zone, or the default when unset or no longer valid. */
function zoneOf(stored: string | null): string {
  const zone = TimeZoneSchema.safeParse(stored === null ? null : JSON.parse(stored));
  return resolveOrgTimeZone(zone.success ? zone.data : null);
}

export const dto = (row: SandboxRow, templateId: string | null): DeveloperSandbox => ({
  id: row.id,
  orgId: row.org_id,
  orgSlug: row.slug,
  templateId,
  previewOnly: true,
  createdAt: row.created_at,
  closedAt: row.closed_at,
  timeZone: zoneOf(row.time_zone),
});

/** The steps of provisioning, in order. A test fails the request after one to prove a retry completes the rest. */
export type SandboxStep =
  | 'org'
  | 'template'
  | 'candidate'
  | 'approval'
  | 'release'
  | 'capture'
  | 'key';
export interface SandboxHooks {
  after?: (step: SandboxStep) => Promise<void>;
}

/** An error a hook threw: it ends the request, where a real template failure is logged and skipped. */
class HookAbort extends Error {
  readonly error: unknown;
  constructor(error: unknown) {
    super('hook');
    this.error = error;
  }
}

/**
 * The quickstart ticket: a copy of the event-ticket blueprint, released in Test. Each step reads what is already
 * there, so a retry after a failure does only what is missing. Its id, or null if it could not be made.
 */
export async function quickstartTemplate(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
  tick: (step: SandboxStep) => Promise<void> = async () => undefined,
): Promise<string | null> {
  const db = ctx.env.DB;
  const scope = { orgId, mode: 'test', provider: 'apple' } as const;
  try {
    let ticket = await ticketOf(db, orgId, SANDBOX_TEMPLATE_NAME);
    if (!ticket) {
      const made = await forkBlueprint(ctx, auth, QUICKSTART_BLUEPRINT, {
        orgId,
        name: SANDBOX_TEMPLATE_NAME,
      });
      if (!('versions' in made)) throw new Error('The blueprint copy has no template.');
      ticket = { id: made.id, version: made.activeVersion ?? made.versions[0]?.version ?? null };
    }
    await tick('template');
    if (await hasTestRelease(db, ticket.id, orgId)) return ticket.id;
    const version = ticket.version ?? '';
    let candidate = await candidateOf(db, ticket.id, orgId, version);
    if (!candidate) {
      const made = await createCandidate(ctx, auth, ticket.id, { ...scope, version });
      candidate = { id: made.id, candidate_hash: made.candidateHash };
    }
    await tick('candidate');
    // The person is the only member, so they approve their own work: Test mode allows it alone.
    let approvalId = await approvalOf(db, candidate.id);
    if (!approvalId)
      approvalId = (
        await approveCandidate(ctx, auth, ticket.id, candidate.id, {
          ...scope,
          candidateHash: candidate.candidate_hash,
          alone: true,
        })
      ).id;
    await tick('approval');
    await publishRelease(ctx, auth, ticket.id, {
      ...scope,
      candidateId: candidate.id,
      approvalId,
      candidateHash: candidate.candidate_hash,
      expectedGeneration: 0,
    });
    await tick('release');
    return ticket.id;
  } catch (error) {
    if (error instanceof HookAbort) throw error;
    // The sandbox is still usable: the person can start from a blueprint themselves, or retry.
    ctx.log.error('developer.sandbox_template_failed', {
      orgId,
      code: 'SANDBOX_TEMPLATE_FAILED',
      error,
    });
    return null;
  }
}

/**
 * Makes the caller's sandbox, or finishes it: a developer org, their admin membership, the Quickstart ticket
 * released in Test and a Test personal key (30 days, shown once). One at a time per person; a deleted one frees the slot. A retry after a failure
 * completes what is missing and returns the sandbox; the key is minted once, so a retry that finds it already
 * made returns `key: null` and `previousKey`, and the person rolls it.
 */
export async function createSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
  hooks: SandboxHooks = {},
  /** `viewedAt`: when the person's browser first opened the quickstart (the funnel's start). */
  options: { viewedAt?: number } = {},
): Promise<CreatedDeveloperSandbox> {
  const db = ctx.env.DB;
  const tick = async (step: SandboxStep) => {
    try {
      await hooks.after?.(step);
    } catch (error) {
      throw new HookAbort(error);
    }
  };
  try {
    let row = await sandboxOfUser(db, session.userId);
    // A closed sandbox is not remade; the person deletes it first (delete.ts) to start over.
    if (row?.closed_at != null) throw new ConflictError(SANDBOX_EXISTS_COPY, 'SANDBOX_EXISTS');
    const now = ctx.clock.now();
    const fresh = row === null;
    if (!row) {
      const email = await primaryEmailOf(db, session.userId);
      if (!email) throw new NotFoundError('Account not found.', 'USER_NOT_FOUND');
      const orgId = ctx.ids.id();
      const slug = `dev-${ctx.ids.id().replaceAll('-', '').slice(-12)}`;
      await insertSandbox(ctx, {
        id: ctx.ids.id(),
        orgId,
        slug,
        name: `Sandbox ${slug.slice(4)}`,
        userId: session.userId,
        email,
        sessionIdHash: session.sessionId,
        membershipId: ctx.ids.id(),
        invitationId: ctx.ids.id(),
        invitationHash: await sha256Hex(ctx.ids.token(32)),
        now,
      });
      row = await sandboxOfUser(db, session.userId);
      await tick('org');
    }
    if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
    await recordSandboxMade(ctx, session, row.org_id, options.viewedAt, fresh);
    // Everything in the sandbox is Test: the person acts in it as a Test session.
    const test: SessionAuth = { ...session, mode: 'test' };
    const templateId = await quickstartTemplate(ctx, test, row.org_id, tick);
    // The webhook tester's endpoint; a sandbox made before it existed gets it on this call.
    await ensureCapture(
      ctx,
      actorOf(test),
      await authorizeWebhooks(ctx, test, row.org_id, 'integrations:manage'),
    );
    await tick('capture');
    await ensureSandboxTerminal(ctx, test, row.org_id);
    const prior = await sandboxKeyOf(db, row.org_id, session.userId, SANDBOX_KEY_NAME);
    if (prior) return { ...dto(row, templateId), key: null, previousKey: prior };
    const key = await mintSandboxKey(ctx, test, row.org_id);
    await tick('key');
    return { ...dto(row, templateId), key, previousKey: null };
  } catch (error) {
    if (error instanceof HookAbort) throw error.error;
    throw error;
  }
}

/** Closes the caller's own sandbox: read-only, its keys revoked, a 30-day window to export. */
export async function closeOwnSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<DeveloperSandbox> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  if (row.closed_at === null) {
    const closed = await closeSandbox(ctx, row.org_id, {
      userId: session.userId,
      sessionIdHash: session.sessionId,
    });
    if (!closed)
      throw new ConflictError('The sandbox changed. Reload and retry.', 'SANDBOX_CONFLICT');
  }
  const after = await sandboxOfUser(ctx.env.DB, session.userId);
  return dto(
    after ?? row,
    await quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME),
  );
}

/** The caller's sandbox, or null. */
export async function getSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<DeveloperSandbox | null> {
  const row = await sandboxOfUser(ctx.env.DB, session.userId);
  return row
    ? dto(row, await quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME))
    : null;
}
