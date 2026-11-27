import { CLI_TOKEN_TTL_MS, type CliClient } from '../../../shared/contracts/cli.ts';
import { WORKBENCH_KEY_SCOPES } from '../../../shared/contracts/workbench.ts';
import { CLI_ACCOUNT_MISMATCH_COPY } from '../../../shared/copy/cli.ts';
import type { ApiScope, SessionAuth } from '../../platform/auth.ts';
import { entitlementsOf, isEntitled } from '../../platform/entitlements.ts';
import { ConflictError, FeatureNotIncludedError, NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { authorizeApiKeys, delegableScopes } from '../api-keys/access.ts';
import { endCliToken } from '../api-keys/repo-cli.ts';
import { createApiKey } from '../api-keys/service-create.ts';
import { recordAudit } from '../audit/service.ts';
import { tokenTail } from './cli-codes.ts';
import type { CliMeta } from './cli-service.ts';
import type { MintTarget } from './repo.ts';
import * as repo from './repo-cli.ts';

/** A person holds up to 5 CLI tokens per org; the sixth approval ends the oldest. */
const MAX_TOKENS = 5;
const SCOPES: readonly string[] = [...WORKBENCH_KEY_SCOPES, 'logs:read'];

/** The label a token shows in Keys: the client as the device reported it. */
const nameOf = (client: CliClient) => `CLI: ${client.name} on ${client.os}`.slice(0, 120);

/**
 * `POST /cli/sessions/{id}/approve`. The caller has proved a Polaris ID session, the step-up and the person's
 * right to the context (`target`). One statement settles the session; the key is made under the person's own
 * membership by the same grant a personal key takes, and bound to this session.
 */
export async function approveCliSession(
  ctx: ServiceContext,
  session: SessionAuth,
  id: string,
  target: MintTarget & { sandbox: boolean },
  meta: CliMeta,
): Promise<void> {
  const now = ctx.clock.now();
  const row = await repo.pendingById(ctx.env.DB, id, now);
  if (!row)
    throw new NotFoundError('No such code. Check it against your terminal.', 'CLI_CODE_NOT_FOUND');
  if (row.account_hint !== null && row.account_hint !== session.userId) {
    await repo.markMismatch(ctx.env.DB, id, now);
    await recordAudit(ctx, {
      orgId: target.org_id,
      actorType: 'user',
      actorId: session.userId,
      action: 'cli_session.account_mismatch',
      targetType: 'cli_session',
      targetId: id,
      ipPrefix: meta.ipPrefix,
    });
    throw new ConflictError(CLI_ACCOUNT_MISMATCH_COPY, 'CLI_ACCOUNT_MISMATCH');
  }
  if (!target.sandbox && !isEntitled(await entitlementsOf(ctx, target.org_id), 'api', 'read'))
    throw new FeatureNotIncludedError('api', "This organization's plan has no API access.");
  if (
    !(await repo.settleCliSession(ctx.env.DB, id, now, {
      state: 'approved',
      userId: session.userId,
      orgId: target.org_id,
      country: meta.country,
    }))
  )
    throw new NotFoundError('No such code. Check it against your terminal.', 'CLI_CODE_NOT_FOUND');
  try {
    // A member's own Test-mode authority, as the personal-key route builds it.
    const authority = await authorizeApiKeys(
      ctx,
      { ...session, mode: 'test' },
      target.org_id,
      'org:read',
    );
    const held = new Set<ApiScope>(delegableScopes(authority));
    const scopes = SCOPES.filter((s): s is ApiScope => held.has(s as ApiScope));
    const key = await createApiKey(
      ctx,
      authority,
      {
        orgId: target.org_id,
        name: nameOf(JSON.parse(row.client) as CliClient),
        kind: 'personal',
        scopes: scopes as never,
        mode: 'test',
        expiresAt: now + CLI_TOKEN_TTL_MS,
      },
      { tail: (prefix) => tokenTail(ctx.env, id, prefix) },
    );
    await repo.attachCliToken(ctx.env.DB, id, key.id);
    // The sixth live token of the person ends the oldest: five at most.
    const live = await repo.liveCliTokens(ctx.env.DB, target.membership_id, now);
    for (const old of live.slice(MAX_TOKENS))
      if (old.id !== key.id && (await endCliToken(ctx.env.DB, old.id, 'limit', now)))
        await recordAudit(ctx, {
          orgId: target.org_id,
          actorType: 'user',
          actorId: session.userId,
          action: 'cli_token.revoked',
          targetType: 'api_key',
          targetId: old.id,
          detail: { reason: 'limit', by: 'system' },
        });
    const detail = { cliSessionId: id, ipPrefix: meta.ipPrefix };
    await recordAudit(ctx, {
      orgId: target.org_id,
      actorType: 'user',
      actorId: session.userId,
      action: 'cli_session.approved',
      targetType: 'cli_session',
      targetId: id,
      ipPrefix: meta.ipPrefix,
      detail: {
        ...detail,
        keyId: key.id,
        startCountry: row.country,
        approveCountry: meta.country,
        mismatch:
          row.ip_prefix !== meta.ipPrefix || (row.country ?? null) !== (meta.country ?? null),
      },
    });
    await recordAudit(ctx, {
      orgId: target.org_id,
      actorType: 'user',
      actorId: session.userId,
      action: 'cli_token.issued',
      targetType: 'api_key',
      targetId: key.id,
      detail: { expiresAt: key.expiresAt },
    });
  } catch (error) {
    await repo.reopenCliSession(ctx.env.DB, id);
    throw error;
  }
}
