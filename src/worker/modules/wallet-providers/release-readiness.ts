import type {
  EnableReadyResult,
  WalletReleaseBlock,
  WalletReleaseEnrolment,
  WalletReleaseMode,
  WalletReleaseReport,
} from '../../../shared/contracts/wallet-release.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { grant, grantedBatch } from '../../platform/authority.ts';
import { entitled } from '../../platform/authority-entitled.ts';
import { AppError, ForbiddenError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { getOrgSettings } from '../settings/service.ts';
import { withLastChecks } from './credential-service.ts';
import { adminOf } from './enrolment-hold.ts';
import { planEnable } from './enrolment-service.ts';
import type { WalletProvider } from './instance-types.ts';
import { WalletProviderDisabledError, walletProviderReleaseState } from './provider-policy.ts';
import { listCredentials } from './repo-credentials.ts';
import { addEnrolmentStep, ENROLMENT_TABLES } from './repo-enrolments.ts';
import {
  countReleaseInstances,
  countReleaseTemplates,
  listReleaseEnrolments,
  type ReleaseEnrolmentRow,
} from './repo-release-readiness.ts';
import { mapWalletWriteError } from './wallet-write-errors.ts';

type Mode = 'live' | 'test';
const PROVIDERS: readonly WalletProvider[] = ['google', 'samsung'];
const MODES: readonly Mode[] = ['test', 'live'];

function admin(auth: SessionAuth): void {
  if (auth?.kind !== 'session' || !auth.roles.includes('admin'))
    throw new ForbiddenError('Admin access is required.');
}

type Plan = Awaited<ReturnType<typeof planEnable>>;

/** What enabling would need, as blocks; a plan when nothing is missing. */
async function planOf(
  ctx: ServiceContext,
  row: ReleaseEnrolmentRow,
  provider: WalletProvider,
  mode: Mode,
): Promise<{ plan: Plan | null; blocks: WalletReleaseBlock[] }> {
  try {
    return {
      plan: await planEnable(ctx, row.org_id, mode, provider, row.enrolment_revision),
      blocks: [],
    };
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (error.code === 'FEATURE_NOT_INCLUDED') return { plan: null, blocks: ['plan'] };
    const missing = (error.issues ?? []).map((i) => String(i.path) as WalletReleaseBlock);
    if (error.code === 'WALLET_ENROLMENT_PREREQUISITE' && missing.length > 0)
      return { plan: null, blocks: missing };
    if (error.code === 'WALLET_ENROLMENT_HELD') return { plan: null, blocks: ['hold'] };
    ctx.log.warn('wallet.release_plan_refused', { orgId: row.org_id, code: error.code });
    return { plan: null, blocks: ['source'] };
  }
}

/** One enrolment as the release sees it; Off rows run the same plan an enable runs. */
async function readEnrolment(
  ctx: ServiceContext,
  row: ReleaseEnrolmentRow,
  provider: WalletProvider,
  mode: Mode,
): Promise<WalletReleaseEnrolment & { plan: Plan | null }> {
  const base = { orgId: row.org_id, orgName: row.org_name, plan: null };
  const fixed: WalletReleaseBlock[] = [];
  if (row.revoked_at !== null) fixed.push('revoked');
  if (row.platform_hold_at !== null) fixed.push('hold');
  if (row.credential_source_id === null) fixed.push(row.credential_id ? 'legacy' : 'source');
  if (!row.entitled) fixed.push('plan');
  if (row.org_status !== 'active') fixed.push('org');
  if (fixed.length > 0) return { ...base, status: 'blocked', blocks: fixed };
  if (row.enabled_at !== null) return { ...base, status: 'issuing', blocks: [] };
  if ((await getOrgSettings(ctx, row.org_id))['channels.blocked'].includes(provider))
    return { ...base, status: 'blocked', blocks: ['channel_off'] };
  const { plan, blocks } = await planOf(ctx, row, provider, mode);
  return plan
    ? { ...base, status: 'ready', blocks: [], plan }
    : { ...base, status: 'blocked', blocks };
}

async function readMode(
  ctx: ServiceContext,
  provider: WalletProvider,
  mode: Mode,
): Promise<WalletReleaseMode & { plans: Map<string, Plan> }> {
  const db = ctx.env.DB;
  const credentials = (await listCredentials(db, { orgId: null, mode, provider })).filter(
    (c) => c.revoked_at === null,
  );
  const rows = await listReleaseEnrolments(db, provider, mode);
  const enrolments = [];
  const plans = new Map<string, Plan>();
  for (const row of rows) {
    const { plan, ...view } = await readEnrolment(ctx, row, provider, mode);
    if (plan) plans.set(row.org_id, plan);
    enrolments.push(view);
  }
  return {
    provider,
    mode,
    state: walletProviderReleaseState(provider, mode),
    credentials: await withLastChecks(ctx, null, credentials),
    enrolments,
    templates: await countReleaseTemplates(db, provider, mode),
    instances: await countReleaseInstances(db, provider, mode),
    plans,
  };
}

/** `GET /platform/wallet-release`: what each provider and mode would issue once released. Reads only. */
export async function releaseReport(
  ctx: ServiceContext,
  auth: SessionAuth,
): Promise<WalletReleaseReport> {
  admin(auth);
  const releases: WalletReleaseMode[] = [];
  for (const provider of PROVIDERS)
    for (const mode of MODES) {
      const { plans: _plans, ...view } = await readMode(ctx, provider, mode);
      releases.push(view);
    }
  return { releases };
}

/**
 * `POST /platform/wallet-release/{provider}/{mode}/enable-ready`: the Off enrolments whose org has not blocked the
 * channel and whose enable plan passes (plan, source, check, Live round trip, no hold). A dry run lists them; an
 * apply turns exactly those On in one batch, each under its own platform grant and audit row, and only while the
 * provider is released in the mode.
 */
export async function enableReady(
  ctx: ServiceContext,
  auth: SessionAuth,
  provider: WalletProvider,
  mode: Mode,
  apply: boolean,
): Promise<EnableReadyResult> {
  admin(auth);
  const read = await readMode(ctx, provider, mode);
  const ready = read.enrolments.filter((e) => e.status === 'ready');
  const enrolments = ready.map((e) => ({ orgId: e.orgId, orgName: e.orgName }));
  if (!apply || ready.length === 0) return { applied: false, enrolments };
  if (read.state !== 'released') throw new WalletProviderDisabledError(provider, 'not_released');
  const grants = ready.map((e) => {
    const plan = read.plans.get(e.orgId);
    if (!plan) throw new Error('Enable plan missing for a ready enrolment.');
    const principal = adminOf(auth, { orgId: e.orgId, mode, provider });
    const g = grant(ctx, {
      purpose: 'org_mode.wallet.enrolment_enable',
      principal,
      checks: [entitled(plan.feature)],
      tables: ENROLMENT_TABLES,
      codes: { config: 'WALLET_ACCOUNT_CONFLICT' },
    });
    addEnrolmentStep(ctx, g, plan.build({ type: 'platform', id: principal.userId }));
    return g;
  });
  try {
    await grantedBatch(ctx.env.DB, grants);
  } catch (error) {
    throw mapWalletWriteError(error);
  }
  ctx.log.info('wallet.release_enable_ready', { provider, mode, count: grants.length });
  return { applied: true, enrolments };
}
