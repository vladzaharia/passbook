import type { z } from 'zod';
import type { MyPassSchema } from '../../../shared/contracts/index.ts';
import { baseUrl } from '../../platform/env.ts';
import { ConflictError, NotFoundError, RateLimitedError } from '../../platform/errors.ts';
import { checkRateLimit } from '../../platform/rate-limit.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { removePassFromUser } from '../holders/service-remove.ts';
import { assetNamesOf } from '../passes/detail.ts';
import { requestRefresh } from '../passes/pass-service-refresh.ts';
import { canPresent } from '../public/presentation.ts';
import { supportContacts } from '../public/service.ts';
import { listWalletOffers } from '../wallet-providers/offers.ts';
import { walletIssuanceByProvider } from '../wallet-providers/provider-policy.ts';
import { bundleSnapshot } from './bundle.ts';
import { sameSnapshot } from './pass-snapshot.ts';
import * as repo from './repo.ts';

export type MyPassDto = z.infer<typeof MyPassSchema>;

/** Seams from other modules, injectable for tests. */
export interface MeDeps {
  requestRefresh: typeof requestRefresh;
  removePassFromUser: typeof removePassFromUser;
}
const defaultDeps: MeDeps = { requestRefresh, removePassFromUser };

function parsePassJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    // Server-owned: the Apple device token must never reach the client.
    const { authenticationToken: _token, ...safe } = parsed as Record<string, unknown>;
    return safe;
  } catch {
    return {};
  }
}

async function toPass(ctx: ServiceContext, row: repo.MyPassRow): Promise<MyPassDto> {
  const base = `${baseUrl(ctx.env)}/p/${row.download_token}`;
  const passJson = parsePassJson(row.pass_json);
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
  if (!presentationEligible) {
    delete passJson.barcode;
    delete passJson.barcodes;
  }
  // Never attach a replacement bearer capability to an older owned row.
  const walletOffers: MyPassDto['walletOffers'] = [];
  if (presentationEligible) {
    for (const { provider, href } of await listWalletOffers(ctx, row.id)) {
      if (href === `/p/${row.download_token}/wallet/${provider}`) {
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
    removedAt: row.removed_at,
    removalMessage: row.removal_message,
    lastRefreshedAt: row.last_refreshed_at,
    refreshRequestedAt: row.refresh_requested_at,
    downloadUrl: `${base}/pass.pkpass`,
    presentationEligible,
    walletOffers,
    walletIssuance: walletIssuanceByProvider(),
    passJson,
    assetBaseUrl: `${base}/assets/`,
    assetNames,
    inWallet: row.registered === 1,
  };
}

export async function listMyPasses(
  ctx: ServiceContext,
  userId: string,
  query: { cursor?: string; limit: number },
) {
  const rows = await repo.listMyPasses(ctx.env.DB, userId, query.cursor, query.limit);
  const page = rows.slice(0, query.limit);
  const built = await Promise.all(page.map((row) => toPass(ctx, row)));
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
        return sameSnapshot(row, current) ? built[index] : toPass(ctx, current);
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

async function ownedRow(ctx: ServiceContext, userId: string, passId: string) {
  const row = await repo.getMyPass(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return row;
}

const DETAIL_READS = 3;

/** A pass that changes while it is built is read again; only one gone from the holder is a 404. */
export async function getMyPass(ctx: ServiceContext, userId: string, passId: string) {
  let row = await ownedRow(ctx, userId, passId);
  for (let attempt = 1; ; attempt++) {
    const [pass, support] = await Promise.all([toPass(ctx, row), supportContacts(ctx, row.org_id)]);
    const current = await repo.getMyPass(ctx.env.DB, userId, passId);
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
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const row = await ownedRow(ctx, userId, passId);
  if (row.status === 'voided') throw new ConflictError('This pass is voided.', 'PASS_VOIDED');
  if (!(await checkRateLimit(ctx.env, 'RL_REFRESH', `refresh:${passId}`))) {
    throw new RateLimitedError();
  }
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
  );
  return { accepted: true as const, requestedAt, cooldownSeconds };
}

export async function removeMyPass(
  ctx: ServiceContext,
  userId: string,
  sessionId: string,
  passId: string,
  deps: MeDeps = defaultDeps,
) {
  const row = await repo.getPassForRemoval(ctx.env.DB, userId, passId);
  if (!row) throw new NotFoundError('Pass not found.', 'PASS_NOT_FOUND');
  return deps.removePassFromUser(ctx, passId, userId, sessionId, {
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
}

export async function getMyRemoval(ctx: ServiceContext, userId: string, transferId: string) {
  const transfer = await repo.getMyRemoval(ctx.env.DB, userId, transferId);
  if (!transfer) throw new NotFoundError('Removal not found.', 'REMOVAL_NOT_FOUND');
  return transfer;
}
