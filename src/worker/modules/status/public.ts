import type { z } from 'zod';
import type {
  PublicComponentIdSchema,
  PublicStateSchema,
  PublicStatus,
} from '../../../shared/contracts/status.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import { latestChecks } from '../wallet-providers/repo-credential-checks.ts';
import type { State } from './checks.ts';
import { rowOf } from './checks-wallet.ts';
import { incidents } from './repo-public.ts';
import { getStatus } from './service.ts';

type PublicState = z.infer<typeof PublicStateSchema>;
type ComponentId = z.infer<typeof PublicComponentIdSchema>;

const DAY = 86_400_000;
const MEMO_MS = 60_000;
const memo = new WeakMap<D1Database, { at: number; value: PublicStatus }>();

/** The names the public page uses, and the internal checks each one is made of. Nothing else leaves. */
const LABELS: Record<ComponentId, string> = {
  api: 'API',
  apple_push: 'Apple push',
  email: 'Email',
  webhooks: 'Webhook delivery',
  google: 'Google Wallet',
  samsung: 'Samsung Wallet',
};
const CHECKS: Partial<Record<ComponentId, string[]>> = {
  api: ['database', 'storage'],
  apple_push: ['identity:platform'],
  email: ['email'],
  webhooks: ['queue'],
};

const PUBLIC_STATE: Record<State, PublicState> = {
  failing: 'outage',
  degraded: 'degraded',
  not_configured: 'off',
  not_in_use: 'off',
  configured: 'operational',
  verified: 'operational',
};
const SEVERITY: Record<PublicState, number> = { outage: 0, degraded: 1, off: 2, operational: 3 };
const worstOf = (states: PublicState[]): PublicState =>
  states.length === 0 ? 'off' : states.reduce((a, b) => (SEVERITY[b] < SEVERITY[a] ? b : a));

/**
 * The public page's data: six components in three states, and incident notes. It reads the platform's own checks
 * through an allowlist; no detail text, count, organization, identity, connection or credential id is carried
 * across, and a wallet provider's state is that of the platform credential alone. Memoized for a minute, so a
 * crowd on the page costs one set of probes.
 */
export async function publicStatus(ctx: ServiceContext): Promise<PublicStatus> {
  const now = ctx.clock.now();
  const hit = memo.get(ctx.env.DB);
  if (hit && now >= hit.at && now - hit.at < MEMO_MS) return hit.value;
  const [status, checks, notes] = await Promise.all([
    getStatus(ctx),
    latestChecks(ctx.env.DB),
    incidents(ctx.env.DB, now - 14 * DAY),
  ]);
  const byId = new Map(status.components.map((c) => [c.id, PUBLIC_STATE[c.state]]));
  const provider = (name: 'google' | 'samsung') =>
    worstOf(
      checks
        .filter((c) => c.scope === 'platform' && c.mode === 'live' && c.provider === name)
        .map((c) => PUBLIC_STATE[rowOf(c, now).state]),
    );
  // Google and Samsung are listed once a platform credential exists: a dark integration is not announced.
  const components = (Object.keys(LABELS) as ComponentId[])
    .map((id) => ({
      id,
      label: LABELS[id],
      state:
        id === 'google' || id === 'samsung'
          ? provider(id)
          : worstOf((CHECKS[id] ?? []).flatMap((c) => byId.get(c) ?? [])),
    }))
    .filter((c) => !(c.state === 'off' && (c.id === 'google' || c.id === 'samsung')));
  const open = notes.filter((n) => n.resolved_at === null && n.impact !== 'notice');
  const overall = worstOf([
    ...components.map((c) => c.state),
    ...open.map((n): PublicState => (n.impact === 'outage' ? 'outage' : 'degraded')),
    'operational',
  ]);
  const value: PublicStatus = {
    overall: overall === 'off' ? 'operational' : overall,
    components,
    incidents: notes.map((n) => ({
      id: n.id,
      title: n.title,
      note: n.note,
      component: n.component,
      impact: n.impact,
      startedAt: n.started_at,
      resolvedAt: n.resolved_at,
    })),
    checkedAt: now,
  };
  memo.set(ctx.env.DB, { at: now, value });
  return value;
}

/** For tests: the memo is per isolate. */
export const clearPublicStatusMemo = (db: D1Database): void => void memo.delete(db);
