import type { ServiceContext } from '../../platform/service-context.ts';
import { type LatestCheck, latestChecks } from '../wallet-providers/repo-credential-checks.ts';
import { type Draft, type State, worst } from './checks.ts';

const DAY = 86_400_000;
/** Daily checks: a result older than two days means the cron stopped. */
const STALE_MS = 2 * DAY;

const PROVIDER = { google: 'Google Wallet', samsung: 'Samsung Wallet' } as const;

const FAILURE: Record<string, string> = {
  auth_failed: 'the provider refused the key',
  issuer_not_found: 'the issuer was not found',
  issuer_mismatch: 'the issuer id does not match',
  card_not_found: 'the card was not found',
  card_not_active: 'the card is not active',
  cert_expired: 'the certificate expired',
  invalid_credentials: 'the credentials are invalid',
  credential_unreadable: 'the stored secret cannot be read or does not match its identity',
  unreachable: 'the provider could not be reached',
};

export function rowOf(c: LatestCheck, now: number): { state: State; detail: string | null } {
  if (c.checked_at === null || c.check_version_id !== c.current_version_id)
    return { state: 'configured', detail: 'Not checked yet.' };
  if (c.ok === 0)
    return {
      // An org's own credential is that org's problem; only the platform's takes the platform down.
      state: c.scope === 'platform' ? 'failing' : 'degraded',
      detail: `Check failed: ${FAILURE[c.code ?? ''] ?? c.code ?? 'unknown'}.`,
    };
  if (c.code === 'cert_expiring')
    return { state: 'degraded', detail: 'Certificate expires within 30 days.' };
  if (now - c.checked_at > STALE_MS) return { state: 'degraded', detail: 'Check is stale.' };
  return { state: 'verified', detail: null };
}

/**
 * Health of the active wallet credentials from their newest check: a summary row, then a row for each
 * credential that is not verified (the same shape as connections). No credentials: not in use.
 */
export async function checkWalletCredentials(ctx: ServiceContext): Promise<Draft[]> {
  const now = ctx.clock.now();
  const rows = (await latestChecks(ctx.env.DB)).map((c) => ({ c, ...rowOf(c, now) }));
  const bad = rows.filter((r) => r.state !== 'verified');
  const count = (state: State) => rows.filter((r) => r.state === state).length;
  const summary: Draft = {
    id: 'wallet-credentials',
    kind: 'build',
    label: 'Wallet credentials',
    state: rows.length === 0 ? 'not_in_use' : worst(rows.map((r) => r.state)),
    detail:
      rows.length === 0
        ? 'No credentials.'
        : bad.length > 0
          ? `${bad.length} of ${rows.length} need attention.`
          : null,
    data: {
      total: rows.length,
      failing: count('failing'),
      degraded: count('degraded'),
      unchecked: count('configured'),
    },
  };
  return [
    summary,
    ...bad.slice(0, 20).map(
      ({ c, state, detail }): Draft => ({
        id: `wallet-credential:${c.id}`,
        kind: 'build',
        label: `${PROVIDER[c.provider]} ${c.mode} (${c.scope})`,
        state,
        detail,
        data: { orgId: c.org_id, provider: c.provider, mode: c.mode, scope: c.scope },
      }),
    ),
  ];
}
