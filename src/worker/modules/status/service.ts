import type { z } from 'zod';
import type {
  StatusResponseSchema,
  WorkflowRunListSchema,
} from '../../../shared/contracts/status.ts';
import { AppError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { lastIdentityCheck } from '../identities/check.ts';
import { ensurePlatformIdentity, listIdentityRows } from '../identities/repo.ts';
import { listPushKeyMeta } from '../identities/repo-push-keys.ts';
import {
  type Component,
  checkBuild,
  checkConnections,
  checkDatabase,
  checkEmail,
  checkOidc,
  checkQueue,
  checkStorage,
  checkWorkflows,
  identityComponent,
  SEVERITY,
  worst,
} from './checks.ts';
import { checkCron } from './cron-check.ts';
import { recentWorkflowRuns } from './repo.ts';
import { checkBreakglass, checkRateLimits, checkTurnstile } from './security-checks.ts';

export { recordCronRun } from './cron.ts';

export type Status = z.infer<typeof StatusResponseSchema>;
type RunList = z.infer<typeof WorkflowRunListSchema>;

const CACHE_TTL_MS = 15_000;
const cache = new WeakMap<D1Database, { at: number; status: Status }>();

export function clearStatusCache(db?: D1Database): void {
  if (db) cache.delete(db);
}

export interface StatusDeps {
  fetch?: typeof fetch;
  /** Skip the short cache (Recheck). Probes stay bounded; OIDC discovery keeps its own cache. */
  fresh?: boolean;
}

async function identityComponents(ctx: ServiceContext) {
  try {
    await ensurePlatformIdentity(ctx.env, ctx.clock.now());
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    ctx.log.info('status.platform_identity_missing', { code: error.code });
  }
  const rows = await listIdentityRows(ctx.env.DB);
  const checks = await Promise.all(rows.map((row) => lastIdentityCheck(ctx.env.DB, row.id)));
  const keyTeams = new Set(
    (await listPushKeyMeta(ctx.env.DB, [...new Set(rows.map((r) => r.team_identifier))])).map(
      (k) => k.team_identifier,
    ),
  );
  const items = rows.map((row, i) => identityComponent(ctx, row, checks[i] ?? null, keyTeams));
  if (!rows.some((r) => r.id === 'platform'))
    items.push({
      id: 'identity:platform',
      kind: 'identity',
      label: 'Platform identity',
      state: 'not_configured',
      detail: 'No platform certificate.',
    });
  return items;
}

/** Overall ignores not_configured parts unless nothing else is configured. */
function overall(components: Component[]): Component['state'] {
  const active = components.filter((c) => c.state !== 'not_configured');
  return active.length ? worst(active.map((c) => c.state)) : 'not_configured';
}

/** Cached for a few seconds per isolate; probes are cheap and bounded. */
export async function getStatus(ctx: ServiceContext, deps: StatusDeps = {}): Promise<Status> {
  const now = ctx.clock.now();
  const hit = cache.get(ctx.env.DB);
  if (!deps.fresh && hit && now >= hit.at && now - hit.at < CACHE_TTL_MS) return hit.status;

  const parts = await Promise.all([
    checkDatabase(ctx),
    checkStorage(ctx),
    checkQueue(ctx),
    checkWorkflows(ctx),
    identityComponents(ctx),
    checkEmail(ctx),
    checkOidc(ctx, deps.fetch ?? fetch),
    checkConnections(ctx),
    checkCron(ctx),
    checkBuild(ctx),
    checkRateLimits(ctx),
    checkBreakglass(ctx),
    checkTurnstile(ctx),
  ]);
  const components: Component[] = parts
    .flat()
    .map((c) => ({ ...c, checkedAt: now }))
    .sort((a, b) => SEVERITY[a.state] - SEVERITY[b.state]);
  const version = ctx.env.CF_VERSION;
  const status: Status = {
    overall: overall(components),
    build: {
      id: version?.id ?? null,
      tag: version?.tag || null,
      timestamp: version?.timestamp ?? null,
    },
    components,
  };
  cache.set(ctx.env.DB, { at: now, status });
  return status;
}

export async function listWorkflowRuns(ctx: ServiceContext): Promise<RunList> {
  const rows = await recentWorkflowRuns(ctx.env.DB, 50);
  return {
    items: rows.map((r) => ({
      instanceId: r.instance_id,
      kind: r.kind,
      orgId: r.org_id,
      targetId: r.target_id,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      errorCode: r.error_code,
    })),
  };
}
