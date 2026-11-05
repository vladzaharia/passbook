import type { z } from 'zod';
import type { ComponentStatusSchema } from '../../../shared/contracts/status.ts';
import { first } from '../../platform/db.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { dailyCapOf, dayStart } from '../auth/magic-caps.ts';
import { readCounter } from '../auth/repo-magic.ts';
import type { lastIdentityCheck } from '../identities/check.ts';
import { apnsBindingPresent } from '../identities/db-resolver.ts';
import type { IdentityRow } from '../identities/repo.ts';
import { getPlatformSettings } from '../settings/service.ts';
import { connectionHealthCounts, unhealthyConnections, workflowCounts } from './repo.ts';

export type Component = z.infer<typeof ComponentStatusSchema>;
type Draft = Omit<Component, 'checkedAt'>;
type State = Component['state'];

const MINUTE = 60_000;
const DAY = 86_400_000;

export const SEVERITY: Record<State, number> = {
  failing: 0,
  degraded: 1,
  not_configured: 2,
  configured: 3,
  verified: 4,
};

export function worst(states: State[]): State {
  return states.reduce<State>((a, b) => (SEVERITY[b] < SEVERITY[a] ? b : a), 'verified');
}

async function guarded(
  ctx: ServiceContext,
  id: string,
  kind: Draft['kind'],
  label: string,
  probe: () => Promise<Draft>,
): Promise<Draft> {
  try {
    return await probe();
  } catch (error) {
    ctx.log.warn('status.probe_failed', { component: id, error });
    return { id, kind, label, state: 'failing', detail: 'Probe failed.' };
  }
}

export function checkDatabase(ctx: ServiceContext): Promise<Draft> {
  return guarded(ctx, 'database', 'database', 'D1 database', async () => {
    await first(ctx.env.DB, 'SELECT 1 AS ok');
    return {
      id: 'database',
      kind: 'database',
      label: 'D1 database',
      state: 'verified',
      detail: null,
    };
  });
}

export function checkStorage(ctx: ServiceContext): Promise<Draft> {
  return guarded(ctx, 'storage', 'storage', 'R2 bucket', async () => {
    await ctx.env.BUCKET.head('status/probe');
    return { id: 'storage', kind: 'storage', label: 'R2 bucket', state: 'verified', detail: null };
  });
}

interface QueueLike {
  metrics(): Promise<{ backlogCount: number; backlogBytes: number; oldestMessageTimestamp?: Date }>;
}

export async function checkQueue(ctx: ServiceContext): Promise<Draft> {
  const base = { id: 'queue', kind: 'queue', label: 'Job queue' } as const;
  const jobs = ctx.env.JOBS as unknown as Partial<QueueLike>;
  const dlq = (ctx.env as unknown as { JOBS_DLQ?: Partial<QueueLike> }).JOBS_DLQ;
  if (!ctx.env.JOBS) return { ...base, state: 'not_configured', detail: 'No queue binding.' };
  if (typeof jobs.metrics !== 'function')
    return { ...base, state: 'configured', detail: 'Queue metrics unavailable.' };
  try {
    const m = await jobs.metrics();
    const oldestAge = m.oldestMessageTimestamp
      ? ctx.clock.now() - m.oldestMessageTimestamp.getTime()
      : 0;
    const dlqDepth = dlq?.metrics ? (await dlq.metrics()).backlogCount : null;
    let state: State = 'verified';
    const notes: string[] = [];
    if (m.backlogCount > 1000 || oldestAge > 15 * MINUTE) {
      state = m.backlogCount > 10_000 ? 'failing' : 'degraded';
      notes.push(`Backlog ${m.backlogCount}.`);
    }
    if (dlqDepth !== null && dlqDepth > 0) {
      state = worst([state, dlqDepth >= 100 ? 'failing' : 'degraded']);
      notes.push(`${dlqDepth} dead-lettered.`);
    }
    if (dlqDepth === null) notes.push('Dead-letter depth unavailable.');
    return {
      ...base,
      state,
      detail: notes.join(' ') || null,
      data: {
        backlog: m.backlogCount,
        oldestAgeSeconds: Math.floor(oldestAge / 1000),
        dlq: dlqDepth,
      },
    };
  } catch (error) {
    ctx.log.warn('status.queue_metrics_failed', { error });
    return { ...base, state: 'configured', detail: 'Queue metrics unavailable.' };
  }
}

export async function checkWorkflows(ctx: ServiceContext): Promise<Draft> {
  const since = ctx.clock.now() - DAY;
  const rows = await workflowCounts(ctx.env.DB, since);
  const count = (status: string) =>
    rows.filter((r) => r.status === status).reduce((sum, r) => sum + r.n, 0);
  const errored = count('errored');
  const total = rows.reduce((sum, r) => sum + r.n, 0);
  const state: State =
    errored >= 5 ? 'failing' : errored > 0 ? 'degraded' : total === 0 ? 'configured' : 'verified';
  return {
    id: 'workflows',
    kind: 'workflow',
    label: 'Workflows (24 h)',
    state,
    detail: errored > 0 ? `${errored} failed.` : total === 0 ? 'No runs.' : null,
    data: { total, errored, running: count('running'), complete: count('complete') },
  };
}

export function identityComponent(
  ctx: ServiceContext,
  row: IdentityRow,
  check: Awaited<ReturnType<typeof lastIdentityCheck>>,
  /** Teams that have an APNs push key. */
  keyTeams: ReadonlySet<string> = new Set(),
): Draft {
  const now = ctx.clock.now();
  const days = row.not_after === null ? null : Math.floor((row.not_after - now) / DAY);
  const bindingNamed = row.apns_binding !== null;
  const bindingPresent = apnsBindingPresent(ctx.env, row.apns_binding);
  const notes: string[] = [];
  let state: State = 'verified';
  const lower = (to: State, note: string) => {
    state = worst([state, to]);
    notes.push(note);
  };
  if (row.not_before !== null && row.not_before > now)
    lower('failing', 'Certificate not valid yet.');
  if (days !== null && days < 0) lower('failing', 'Certificate expired.');
  else if (days !== null && days <= 30) lower('degraded', `Expires in ${days} d.`);
  if (check && !check.ok) lower('failing', `Key check failed: ${check.code ?? 'unknown'}.`);
  if (row.source === 'db' && !check) lower('configured', 'Not checked yet.');
  const pushMethod = bindingPresent
    ? 'certificate'
    : keyTeams.has(row.team_identifier)
      ? 'key'
      : 'none';
  if (pushMethod === 'none') {
    if (bindingNamed) lower('degraded', `APNs binding ${row.apns_binding} is missing.`);
    else lower('configured', 'Push unavailable: no APNs binding or push key.');
  } else if (row.apns_health === 'failing') lower('failing', 'APNs is failing.');
  else if (row.apns_health === 'unknown') lower('configured', 'APNs not verified.');
  return {
    id: `identity:${row.id}`,
    kind: 'identity',
    label: `${row.label} (${row.pass_type_identifier})`,
    state,
    detail: notes.join(' ') || null,
    data: {
      source: row.source,
      daysRemaining: days,
      apnsBinding: row.apns_binding,
      bindingPresent,
      pushMethod,
      apnsHealth: row.apns_health,
      orgId: row.org_id,
    },
  };
}

export async function checkEmail(ctx: ServiceContext): Promise<Draft> {
  const configured = Boolean(ctx.env.EMAIL && ctx.env.EMAIL_FROM);
  const magicCap = dailyCapOf(ctx.env);
  const magicToday = await readCounter(ctx.env.DB, 'magic:daily', dayStart(ctx.clock.now()));
  const state: State = !configured
    ? 'not_configured'
    : magicToday >= magicCap
      ? 'failing'
      : magicToday >= magicCap * 0.8
        ? 'degraded'
        : 'configured';
  return {
    id: 'email',
    kind: 'email',
    label: 'Email Sending',
    state,
    detail: !configured
      ? 'No EMAIL binding or sender.'
      : state === 'configured'
        ? null
        : `Sign-in mail ${magicToday} of ${magicCap} today.`,
    data: { sender: ctx.env.EMAIL_FROM || null, magicToday, magicCap },
  };
}

const OIDC_TTL_MS = 5 * MINUTE;
const oidcCache = new Map<string, { at: number; draft: Draft }>();

export function clearOidcCache(): void {
  oidcCache.clear();
}

function withTrust(draft: Draft, trustOn: boolean): Draft {
  if (!trustOn) return draft;
  return {
    ...draft,
    state: worst([draft.state, 'degraded']),
    detail: draft.detail ?? 'Email trust on.',
  };
}

export async function checkOidc(ctx: ServiceContext, fetchImpl: typeof fetch): Promise<Draft> {
  const issuer = ctx.env.OIDC_ISSUER?.replace(/\/+$/, '');
  const base = { id: 'oidc', kind: 'oidc', label: 'Polaris ID' } as const;
  if (!issuer) return { ...base, state: 'not_configured', detail: 'No issuer.' };
  const trustOn = (await getPlatformSettings(ctx))['oidc.trustEmail'];
  const hit = oidcCache.get(issuer);
  const now = ctx.clock.now();
  if (hit && now >= hit.at && now - hit.at < OIDC_TTL_MS) return withTrust(hit.draft, trustOn);
  let draft: Draft;
  try {
    const res = await fetchImpl(`${issuer}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(3000),
      redirect: 'manual',
    });
    const body = res.ok ? ((await res.json()) as { issuer?: string }) : null;
    draft =
      body?.issuer !== undefined
        ? { ...base, state: 'verified', detail: null }
        : { ...base, state: 'degraded', detail: `Discovery returned ${res.status}.` };
  } catch (error) {
    ctx.log.warn('status.oidc_unreachable', { error });
    draft = { ...base, state: 'degraded', detail: 'Discovery unreachable.' };
  }
  oidcCache.set(issuer, { at: now, draft });
  return withTrust(draft, trustOn);
}

export async function checkConnections(ctx: ServiceContext): Promise<Draft[]> {
  const counts = await connectionHealthCounts(ctx.env.DB);
  const total = counts.reduce((sum, r) => sum + r.n, 0);
  const sum = (health: string) =>
    counts.filter((r) => r.health === health).reduce((s, r) => s + r.n, 0);
  const failing = sum('failing');
  const degraded = sum('degraded');
  const summary: Draft = {
    id: 'connections',
    kind: 'connection',
    label: 'Connections',
    state:
      total === 0
        ? 'not_configured'
        : failing > 0
          ? 'failing'
          : degraded > 0
            ? 'degraded'
            : sum('healthy') === total
              ? 'verified'
              : 'configured',
    detail:
      total === 0 ? 'None.' : failing + degraded > 0 ? `${failing + degraded} unhealthy.` : null,
    data: { total, healthy: sum('healthy'), degraded, failing, unknown: sum('unknown') },
  };
  const bad = await unhealthyConnections(ctx.env.DB, 20);
  return [
    summary,
    ...bad.map(
      (c): Draft => ({
        id: `connection:${c.id}`,
        kind: 'connection',
        label: c.name,
        state: c.health === 'failing' ? 'failing' : 'degraded',
        detail: failuresLine(c.consecutive_failures),
        data: { orgId: c.org_id, health: c.health },
      }),
    ),
  ];
}

export function failuresLine(n: number): string | null {
  if (n <= 0) return null;
  return `${n} consecutive ${n === 1 ? 'failure' : 'failures'}.`;
}

export function checkBuild(ctx: ServiceContext): Draft {
  const id = ctx.env.CF_VERSION?.id ?? null;
  return {
    id: 'build',
    kind: 'build',
    label: 'Build',
    state: id ? 'verified' : 'configured',
    detail: id ? null : 'No version metadata.',
    data: { id },
  };
}
