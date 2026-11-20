import {
  type CreatedDeveloperSandbox,
  type DeveloperSandbox,
  MINTABLE_SCOPES,
} from '../../../shared/contracts/index.ts';
import {
  SANDBOX_EXISTS_COPY,
  SANDBOX_KEY_NAME,
  SANDBOX_TEMPLATE_NAME,
} from '../../../shared/copy/developer.ts';
import { isPlatformScope } from '../../platform/api-scopes.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { ConflictError, NotFoundError } from '../../platform/errors.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { enforceRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeApiKeys } from '../api-keys/access.ts';
import { createApiKey } from '../api-keys/service-create.ts';
import { approveCandidate, publishRelease } from '../templates/releases.ts';
import { createCandidate } from '../templates/releases-create.ts';
import { useBlueprint as forkBlueprint } from '../templates/use-blueprint.ts';
import { primaryEmailOf, quickstartTemplateOf, type SandboxRow, sandboxOfUser } from './repo.ts';
import { insertSandbox } from './repo-grants.ts';

/** The quickstart's blueprint, and how long its test key lives. */
const QUICKSTART_BLUEPRINT = 'baked:starter-event-ticket';
const KEY_TTL_MS = 30 * 86_400_000;

/** A key a sandbox holds can reach everything a test org can, except minting keys and the terminal scope. */
const KEY_SCOPES = MINTABLE_SCOPES.filter(
  (s) => !isPlatformScope(s) && s !== 'api-keys:write' && s !== 'scans:write',
);

const dto = (row: SandboxRow, templateId: string | null): DeveloperSandbox => ({
  id: row.id,
  orgId: row.org_id,
  orgSlug: row.slug,
  templateId,
  previewOnly: true,
  createdAt: row.created_at,
  closedAt: row.closed_at,
});

/** The quickstart ticket: a copy of the event-ticket blueprint, released in Test. Its id, or null if it could not be made. */
async function quickstartTemplate(
  ctx: ServiceContext,
  auth: SessionAuth,
  orgId: string,
): Promise<string | null> {
  const scope = { orgId, mode: 'test', provider: 'apple' } as const;
  try {
    const made = await forkBlueprint(ctx, auth, QUICKSTART_BLUEPRINT, {
      orgId,
      name: SANDBOX_TEMPLATE_NAME,
    });
    if (!('versions' in made)) throw new Error('The blueprint copy has no template.');
    const version = made.activeVersion ?? made.versions[0]?.version ?? '';
    const candidate = await createCandidate(ctx, auth, made.id, { ...scope, version });
    // The person is the only member, so they approve their own work: Test mode allows it alone.
    const approval = await approveCandidate(ctx, auth, made.id, candidate.id, {
      ...scope,
      candidateHash: candidate.candidateHash,
      alone: true,
    });
    await publishRelease(ctx, auth, made.id, {
      ...scope,
      candidateId: candidate.id,
      approvalId: approval.id,
      candidateHash: candidate.candidateHash,
      expectedGeneration: 0,
    });
    return made.id;
  } catch (error) {
    // The sandbox is still usable: the person can start from a blueprint themselves.
    ctx.log.error('developer.sandbox_template_failed', {
      orgId,
      code: 'SANDBOX_TEMPLATE_FAILED',
      error,
    });
    return null;
  }
}

/**
 * Makes the caller's sandbox: a developer org, their admin membership, a Test personal key (30 days, shown once)
 * and the Quickstart ticket template released in Test. One per person.
 */
export async function createSandbox(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<CreatedDeveloperSandbox> {
  const db = ctx.env.DB;
  await enforceRateLimit(ctx.env, 'RL_REFRESH', `RL_REFRESH:developer-sandbox:${session.userId}`);
  if (await sandboxOfUser(db, session.userId))
    throw new ConflictError(SANDBOX_EXISTS_COPY, 'SANDBOX_EXISTS');
  const email = await primaryEmailOf(db, session.userId);
  if (!email) throw new NotFoundError('Account not found.', 'USER_NOT_FOUND');
  const now = ctx.clock.now();
  const orgId = ctx.ids.id();
  const slug = `dev-${ctx.ids.id().replaceAll('-', '').slice(-12)}`;
  const sandboxId = ctx.ids.id();
  await insertSandbox(ctx, {
    id: sandboxId,
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
  // Everything in the sandbox is Test: the person acts in it as a Test session.
  const test: SessionAuth = { ...session, mode: 'test' };
  const templateId = await quickstartTemplate(ctx, test, orgId);
  const authority = await authorizeApiKeys(ctx, test, orgId, 'org:read');
  const key = await createApiKey(ctx, authority, {
    orgId,
    name: SANDBOX_KEY_NAME,
    kind: 'personal',
    mode: 'test',
    scopes: KEY_SCOPES,
    expiresAt: now + KEY_TTL_MS,
  });
  const row = await sandboxOfUser(db, session.userId);
  if (!row) throw new NotFoundError('Sandbox not found.', 'SANDBOX_NOT_FOUND');
  return {
    ...dto(row, templateId),
    key: {
      id: key.id,
      name: key.name,
      secret: key.secret,
      mode: 'test',
      expiresAt: key.expiresAt ?? now + KEY_TTL_MS,
    },
  };
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
