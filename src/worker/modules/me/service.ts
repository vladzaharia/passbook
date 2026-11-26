import type { z } from 'zod';
import type { Personalization } from '../../../passkit/types.ts';
import type { MyPassSchema, MyTag } from '../../../shared/contracts/index.ts';
import { revealToken } from '../../platform/capability-token.ts';
import { baseUrl } from '../../platform/env.ts';
import { AppError, ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { type HolderChannels, holderChannels, holderChannelsMany } from '../channels/gate.ts';
import { voidedAt } from '../events/repo-voided.ts';
import { removePassFromUser } from '../holders/service-remove.ts';
import { assetNamesOf } from '../passes/detail.ts';
import { requestRefresh } from '../passes/pass-service-refresh.ts';
import { canPresent } from '../public/presentation.ts';
import { supportContacts } from '../public/service.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { walletIssuanceByProvider } from '../wallet-providers/provider-policy.ts';
import { bundleSnapshot } from './bundle.ts';
import { FIRST_CHECK_S, sendRemovalCheck } from './operations.ts';
import { activeHolderOperation, startHolderOperation } from './operations-start.ts';
import { sameSnapshot } from './pass-snapshot.ts';
import * as repo from './repo.ts';
import { tagsByPass } from './repo-tags.ts';

export type MyPassDto = z.infer<typeof MyPassSchema>;

/** Seams from other modules, injectable for tests. */
export interface MeDeps {
  requestRefresh: typeof requestRefresh;
  removePassFromUser: typeof removePassFromUser;
}
const defaultDeps: MeDeps = { requestRefresh, removePassFromUser };

// A stuck pass is read on every list: the first log per pass is the error, repeats are warnings.
const logged = new Set<string>();
function logPassJson(ctx: ServiceContext, row: repo.MyPassRow, code: string, extra?: object) {
  const key = `${code}:${row.id}`;
  const repeat = logged.has(key);
  if (!repeat) {
    if (logged.size >= 1000) logged.clear();
    logged.add(key);
  }
  const data = { passId: row.id, orgId: row.org_id, version: row.version, code, ...extra };
  const event = code === 'MY_PASS_JSON_MISSING' ? 'me.pass_json_missing' : 'me.pass_json_invalid';
  if (repeat) ctx.log.warn(event, data);
  else ctx.log.error(event, data);
}

function parsePassJson(ctx: ServiceContext, row: repo.MyPassRow): Record<string, unknown> {
  if (!row.pass_json) {
    logPassJson(ctx, row, 'MY_PASS_JSON_MISSING');
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(row.pass_json);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      logPassJson(ctx, row, 'MY_PASS_JSON_INVALID');
      return {};
    }
    // Server-owned: the Apple device token must never reach the client.
    const { authenticationToken: _token, ...safe } = parsed as Record<string, unknown>;
    return safe;
  } catch (error) {
    // The parse error message quotes the pass.json (holder data): name only.
    logPassJson(ctx, row, 'MY_PASS_JSON_INVALID', {
      errorName: error instanceof Error ? error.name : 'unknown',
    });
    return {};
  }
}

const gateKey = (row: repo.MyPassRow) => ({
  id: row.id,
  orgId: row.org_id,
  mode: row.mode,
  templateId: row.template_id,
  templateVersion: row.template_version,
});

async function toPass(
  ctx: ServiceContext,
  row: repo.MyPassRow,
  tags: MyTag[],
  known?: HolderChannels,
): Promise<MyPassDto> {
  // A stored link that cannot be shown (logged by the reveal) lists without links: rotate it.
  const plainToken = await revealToken(
    ctx.env,
    'pass',
    row.id,
    row.org_id,
    row.download_token,
  ).catch((error: unknown) => {
    if (error instanceof AppError && error.code.startsWith('TOKEN_SEAL_')) return null;
    throw error;
  });
  const base = plainToken === null ? null : `${baseUrl(ctx.env)}/p/${plainToken}`;
  const passJson = parsePassJson(ctx, row);
  const readOnly = row.read_only === 1;
  const { effective: channels, holderPrint } = known ?? (await holderChannels(ctx, gateKey(row)));
  const presentationEligible =
    row.org_status === 'active' &&
    canPresent(
      {
        status: row.status,
        removedAt: row.removed_at,
        deletedAt: row.deleted_at,
        testDataQuarantined: row.test_data_quarantined !== 0,
      },
      { voided: passJson.voided, expirationDate: passJson.expirationDate },
      ctx.clock.now(),
    );
  if (!presentationEligible || !channels.mobile.on) {
    delete passJson.barcode;
    delete passJson.barcodes;
  }
  // Never attach a replacement bearer capability to an older owned row.
  const walletOffers: MyPassDto['walletOffers'] = [];
  if (presentationEligible && plainToken !== null) {
    for (const { provider, href } of await listWalletOffers(ctx, row.id, channels)) {
      if (href === `/p/${plainToken}/wallet/${provider}`) {
        // Provider credentials and short-lived offer tokens stay server-side.
        walletOffers.push({ provider, href, installation: 'unknown' });
      }
    }
  }
  const assetNames = await assetNamesOf(ctx, {
    id: row.id,
    orgId: row.org_id,
    templateId: row.template_id,
    templateVersion: row.template_version,
    personalization: JSON.parse(row.personalization) as Personalization,
  });
  return {
    id: row.id,
    title: row.display_title,
    subtitle: row.display_subtitle,
    templateName: row.template_name,
    orgName: row.org_name,
    status: row.status,
    mode: row.mode,
    modifiedAt: row.modified_at,
    voidedAt: row.status === 'voided' ? await voidedAt(ctx.env.DB, row.org_id, row.id) : null,
    removedAt: row.removed_at,
    removalMessage: row.removal_message,
    lastRefreshedAt: row.last_refreshed_at,
    refreshRequestedAt: row.refresh_requested_at,
    downloadUrl: base === null || readOnly || !channels.apple.on ? null : `${base}/pass.pkpass`,
    pageUrl: base,
    presentationEligible,
    channels,
    holderPrint,
    walletOffers,
    walletIssuance: walletIssuanceByProvider(row.mode),
    passJson,
    assetBaseUrl: base === null ? null : `${base}/assets/`,
    assetNames,
    tags,
    inWallet: row.registered === 1,
    readOnly,
  };
}

export async function listMyPasses(
  ctx: ServiceContext,
  userId: string,
  query: { cursor?: string; limit: number },
) {
  const rows = await repo.listMyPasses(ctx.env.DB, userId, query.cursor, query.limit);
  const page = rows.slice(0, query.limit);
  const tags = await tagsByPass(ctx.env.DB, userId, page, ctx.clock.now());
  const known = await holderChannelsMany(ctx, page.map(gateKey));
  const build = (row: repo.MyPassRow) =>
    toPass(ctx, row, tags.get(row.id) ?? [], known.get(row.id));
  const built = await Promise.all(page.map(build));
  const snapshot = await repo.portfolioSnapshot(
    ctx.env.DB,
    userId,
    page.map((row) => row.id),
  );
  const byId = new Map(snapshot.current.map((row) => [row.id, row]));
  // A pass that changed during the reads (a refresh, a reissue) is built again from the newer
  // row; only one no longer owned or presentable leaves the page.
  const items = (
    await Promise.all(
      page.map(async (row, index) => {
        const current = byId.get(row.id);
        if (!current) return null;
        return sameSnapshot(row, current) ? built[index] : build(current);
      }),
    )
  ).filter((item): item is MyPassDto => item != null);
  const reissueRequired = await Promise.all(
    snapshot.reissueRequired.map(async ({ orgId, ...rest }) => {
      const { email, url } = await supportContacts(ctx, orgId);
      return { ...rest, support: { email, url } };
    }),
  );
  return {
    items,
    pendingRemovals: snapshot.pendingRemovals,
    reissueRequired,
    bundle: await bundleSnapshot(ctx, userId),
    nextCursor: rows.length > query.limit ? (page.at(-1)?.id ?? null) : null,
  };
}

async function ownedRow(
  ctx: ServiceContext,
  userId: string,
  passId: string,
  read = repo.getMyPass,
) {
  const row = await read(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return row;
}

const DETAIL_READS = 3;

/** A pass that changes while it is built is read again; only one gone from the holder is a 404. */
export async function getMyPass(ctx: ServiceContext, userId: string, passId: string) {
  let row = await ownedRow(ctx, userId, passId, repo.getMyPassListed);
  for (let attempt = 1; ; attempt++) {
    const tags = await tagsByPass(ctx.env.DB, userId, [row], ctx.clock.now());
    const [pass, support] = await Promise.all([
      toPass(ctx, row, tags.get(row.id) ?? []),
      supportContacts(ctx, row.org_id),
    ]);
    const current = await repo.getMyPassListed(ctx.env.DB, userId, passId);
    if (!current) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
    if (sameSnapshot(row, current)) return { ...pass, support };
    if (attempt >= DETAIL_READS) {
      throw new ConflictError('This pass is changing. Reload in a moment.', 'PASS_CHANGING');
    }
    row = current;
  }
}

export async function refreshMyPass(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const who = { userId, sessionId };
  const row = await ownedRow(ctx, userId, passId);
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `refresh:${passId}`))) {
    throw new RateLimitedError();
  }
  let operationId: string | undefined;
  const { requestedAt, cooldownSeconds } = await deps.requestRefresh(
    ctx,
    passId,
    { type: 'user', id: userId },
    {
      orgId: row.org_id,
      mode: row.mode,
      identityId: row.identity_id,
      templateId: row.template_id,
      templateVersion: row.template_version,
      releaseId: row.release_id,
      version: row.version,
      credentialGeneration: row.credential_generation,
      lifecycleGeneration: row.lifecycle_generation,
      linkGeneration: row.link_generation,
      status: row.status,
      connectionId: row.connection_id,
      externalRef: row.external_ref,
      ownerUserId: userId,
    },
    undefined,
    {
      onClaimed: async () => {
        // A refresh still running on this pass is the one this click joins: its job carries the id.
        operationId =
          (await activeHolderOperation(ctx, who, 'holder.refresh', passId)) ?? undefined;
        if (operationId) return undefined;
        const op = await startHolderOperation(ctx, who, 'holder.refresh', passId);
        await op.progress.step('check').done();
        operationId = op.id;
        return op.id;
      },
    },
  );
  // Inside the cooldown nothing new starts: the earlier refresh's operation, if it still runs.
  operationId ??= (await activeHolderOperation(ctx, who, 'holder.refresh', passId)) ?? undefined;
  return {
    accepted: true as const,
    requestedAt,
    cooldownSeconds,
    ...(operationId ? { operationId } : {}),
  };
}

/** The pass as the holder saw it: the transfer refuses if it moved since. */
export const sourceOf = (userId: string, row: repo.MyPassRow) => ({
  orgId: row.org_id,
  mode: row.mode,
  holderEmail: row.holder_email,
  ownerUserId: userId,
  version: row.version,
  revision: row.revision,
  rowVersion: row.row_version,
  credentialGeneration: row.credential_generation,
  lifecycleGeneration: row.lifecycle_generation,
  releaseId: row.release_id,
  downloadToken: row.download_token,
  linkGeneration: row.link_generation,
});

export async function removeMyPass(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const row = await repo.getPassForRemoval(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  const who = { userId, sessionId };
  const result = await deps.removePassFromUser(
    ctx,
    passId,
    userId,
    sessionId,
    sourceOf(userId, row),
  );
  const op = await startHolderOperation(ctx, who, 'holder.remove', passId);
  await op.progress.step('account').done();
  if (result.state === 'completed') {
    await op.progress.step('wallets').skip();
    await op.progress.succeed();
  } else {
    await op.progress.waiting('wallets', { reason: 'Waiting for your wallets' });
    // The wallets let go on the minute cron: look again until they have.
    await sendRemovalCheck(ctx, op.id, 1, FIRST_CHECK_S);
  }
  return { ...result, operationId: op.id };
}

export async function getMyRemoval(ctx: ServiceContext, userId: string, transferId: string) {
  const transfer = await repo.getMyRemoval(ctx.env.DB, userId, transferId);
  if (!transfer) throw new NotFoundError('Removal not found.', 'REMOVAL_NOT_FOUND');
  return transfer;
}
