import type {
  DeveloperHome,
  DeveloperHomeEndpoint,
  DeveloperHomeSandbox,
  DeveloperLiveOrg,
  DeveloperProgress,
  DeveloperUsage,
} from '../../../shared/contracts/developer-home.ts';
import { SANDBOX_KEY_NAME, SANDBOX_TEMPLATE_NAME } from '../../../shared/copy/developer.ts';
import type { SessionAuth } from '../../platform/auth.ts';
import { entitlementsOf } from '../../platform/entitlements.ts';
import { baseUrl } from '../../platform/env.ts';
import { parseJsonArray } from '../../platform/json-column.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { parseScopes } from '../api-keys/service-dto.ts';
import { listMyOrgMemberships } from '../orgs/access.ts';
import { quotasOf } from '../workbench/quotas.ts';
import { testPreviewUrl } from './fence.ts';
import { quickstartTemplateOf, sandboxKeyOf } from './repo.ts';
import {
  callHours,
  capturesSince,
  endpointsOf,
  type HomeEndpointRow,
  type HomeSandboxRow,
  homeSandboxOf,
  latestTestPasses,
  openKeysOf,
  testPassCount,
} from './repo-home.ts';
import { listLogs } from './repo-request-log.ts';
import { entryOf } from './request-log-service.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const CALLS = 8;
const PASSES = 3;

/**
 * The track since it last started. Before any reset the clock starts at the quickstart view, or the sandbox if that
 * came first; `call` is done once a pass exists, however it was made.
 */
export function progressOf(row: HomeSandboxRow): DeveloperProgress {
  const startedAt =
    row.track_started_at ?? Math.min(row.quickstart_viewed_at ?? row.created_at, row.created_at);
  const steps = [
    ['call', row.track_pass_at],
    ['change', row.track_change_at],
    ['webhook', row.track_webhook_at],
  ] as const;
  const next = steps.find(([, at]) => at === null)?.[0] ?? null;
  const doneAt = next === null ? Math.max(...steps.map(([, at]) => at ?? 0)) : null;
  return {
    startedAt,
    restartedAt: row.track_started_at,
    sandboxAt: row.track_started_at ?? row.created_at,
    keyCallAt: row.track_key_call_at,
    passAt: row.track_pass_at,
    changeAt: row.track_change_at,
    webhookAt: row.track_webhook_at,
    doneAt,
    doneMs: doneAt === null ? null : Math.max(0, doneAt - startedAt),
    next,
  };
}

/** 24 clock hours ending with the current one; the 24-hour totals also count the part-hour before them. */
async function usageOf(ctx: ServiceContext, orgId: string, now: number): Promise<DeveloperUsage> {
  const db = ctx.env.DB;
  const firstHour = Math.floor(now / HOUR) - 23;
  const [hours, captures24h, passes] = await Promise.all([
    callHours(db, orgId, now - DAY),
    capturesSince(db, orgId, now - DAY),
    testPassCount(db, orgId),
  ]);
  const calls = Array.from({ length: 24 }, () => 0);
  const errors = Array.from({ length: 24 }, () => 0);
  for (const h of hours) {
    const i = h.hour - firstHour;
    if (i < 0 || i > 23) continue;
    calls[i] = h.calls;
    errors[i] = h.errors;
  }
  return {
    calls24h: hours.reduce((n, h) => n + h.calls, 0),
    errors24h: hours.reduce((n, h) => n + h.errors, 0),
    captures24h,
    passes,
    series: { from: firstHour * HOUR, calls, errors },
  };
}

const limit = (v: unknown): number | null => (typeof v === 'number' ? v : null);

async function sandboxOf(
  ctx: ServiceContext,
  row: HomeSandboxRow,
  now: number,
): Promise<DeveloperHomeSandbox> {
  const [e, templateId] = await Promise.all([
    entitlementsOf(ctx, row.org_id),
    quickstartTemplateOf(ctx.env.DB, row.org_id, SANDBOX_TEMPLATE_NAME),
  ]);
  return {
    id: row.id,
    orgId: row.org_id,
    orgSlug: row.slug,
    name: row.name,
    templateId,
    mode: 'test',
    previewOnly: true,
    createdAt: row.created_at,
    closedAt: row.closed_at,
    closeReason: row.close_reason,
    reopenUntil:
      row.closed_at !== null && row.purge_after !== null && row.purge_after > now
        ? row.purge_after
        : null,
    limits: {
      passes: limit(e['passes.test']),
      templates: limit(e.templates),
      endpoints: limit(e['webhooks.endpoints']),
      keys: limit(e['api.keys']),
    },
  };
}

function endpointOf(r: HomeEndpointRow): DeveloperHomeEndpoint {
  const capture = r.target === 'capture';
  const lastUrl = Math.max(r.last_success_at ?? 0, r.last_failure_at ?? 0) || null;
  const lastAt = capture ? r.capture_at : lastUrl;
  return {
    id: r.id,
    target: r.target,
    url: capture ? null : r.url,
    status: r.status,
    eventTypes: parseJsonArray(
      r.event_types,
      'event_types',
      (t): t is string => typeof t === 'string',
    ),
    lastAt,
    lastOk:
      lastAt === null
        ? null
        : capture
          ? (r.capture_status ?? 200) < 300
          : (r.last_success_at ?? 0) >= (r.last_failure_at ?? 0),
  };
}

/** Where the person can get a Live key: their organizations that are not sandboxes. */
async function liveOrgsOf(ctx: ServiceContext, userId: string): Promise<DeveloperLiveOrg[]> {
  return (await listMyOrgMemberships(ctx, userId))
    .filter((m) => !m.testOnly)
    .map((m) => ({
      orgId: m.orgId,
      name: m.orgName,
      slug: m.orgSlug,
      roles: m.roles,
      // A member makes their own personal key with any role that reads the org (api-keys routes).
      canMintLive: m.capabilities.includes('org:read'),
    }));
}

/**
 * The signed-in developer's workbench. Everything is read from the person's own sandbox (found by their user id,
 * never by an id in the request) and their own memberships, so no other person's data can appear.
 */
export async function developerHome(
  ctx: ServiceContext,
  session: SessionAuth,
): Promise<DeveloperHome> {
  const db = ctx.env.DB;
  const now = ctx.clock.now();
  const [row, liveOrgs] = await Promise.all([
    homeSandboxOf(db, session.userId),
    liveOrgsOf(ctx, session.userId),
  ]);
  if (!row)
    return {
      now,
      state: 'none',
      sandbox: null,
      progress: null,
      usage: null,
      quotas: null,
      keys: [],
      calls: [],
      endpoints: [],
      passes: [],
      liveOrgs,
    };
  const orgId = row.org_id;
  const [sandbox, usage, quotas, keys, sandboxKey, calls, endpoints, passes] = await Promise.all([
    sandboxOf(ctx, row, now),
    usageOf(ctx, orgId, now),
    quotasOf(ctx, orgId),
    openKeysOf(db, orgId, now),
    sandboxKeyOf(db, orgId, session.userId, SANDBOX_KEY_NAME),
    listLogs(db, orgId, { portal: 'hide' }, CALLS, now),
    endpointsOf(db, orgId),
    latestTestPasses(db, orgId, PASSES),
  ]);
  const base = baseUrl(ctx.env);
  return {
    now,
    state: row.closed_at === null ? 'open' : 'closed',
    sandbox,
    progress: progressOf(row),
    usage,
    quotas,
    keys: keys.map((k) => ({
      id: k.id,
      name: k.name,
      secretPrefix: `${k.secret_label}_${k.prefix}`,
      scopes: parseScopes(k.scopes),
      createdAt: k.created_at,
      expiresAt: k.expires_at,
      lastUsedAt: k.last_used_at,
      retireAt: k.retire_at,
      sandboxKey: k.id === sandboxKey?.id,
    })),
    calls: calls.map((r) => entryOf(r)),
    endpoints: endpoints.map(endpointOf),
    passes: await Promise.all(
      passes.map(async (p) => ({
        id: p.id,
        templateId: p.template_id,
        title: p.display_title,
        subtitle: p.display_subtitle,
        status: p.status,
        version: p.version,
        createdAt: p.created_at,
        modifiedAt: p.modified_at,
        previewUrl: await testPreviewUrl(
          ctx.env,
          base,
          { id: p.id, linkGeneration: p.link_generation },
          now,
        ),
      })),
    ),
    liveOrgs,
  };
}
