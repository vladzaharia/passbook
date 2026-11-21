import { NotFoundError } from '../../platform/errors.ts';
import type { ServiceContext } from '../../platform/service-context.ts';
import type { lastIdentityCheck } from '../identities/check.ts';
import { apnsBindingPresent, platformEnvMismatch } from '../identities/db-resolver.ts';
import { readEnvIdentity } from '../identities/env-identity.ts';
import { pushMethodOf } from '../identities/push-method.ts';
import type { IdentityRow } from '../identities/repo.ts';
import { type Draft, type State, worst } from './checks.ts';

const DAY = 86_400_000;

/** Live, not from the daily check: a bad deploy refuses signing at once. */
function envMismatchOf(ctx: ServiceContext, row: IdentityRow): boolean {
  if (row.source !== 'env') return false;
  try {
    return platformEnvMismatch(readEnvIdentity(ctx.env), row);
  } catch (error) {
    if (error instanceof NotFoundError) return false;
    throw error;
  }
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
  if (envMismatchOf(ctx, row))
    lower('failing', 'Configured pass type differs from the installed one. Signing is refused.');
  if (row.not_before !== null && row.not_before > now)
    lower('failing', 'Certificate not valid yet.');
  if (days !== null && days < 0) lower('failing', 'Certificate expired.');
  else if (days !== null && days <= 30)
    lower('degraded', `${days} ${days === 1 ? 'day' : 'days'} left.`);
  if (row.rotation === 'auto' && days !== null && days >= 0 && days <= 14)
    lower('failing', 'Automatic renewal has not replaced it. Renew manually.');
  if (check && !check.ok) lower('failing', `Key check failed: ${check.code ?? 'unknown'}.`);
  if (row.source === 'db' && !check) lower('configured', 'Not checked yet.');
  const pushMethod = pushMethodOf(ctx.env, row.apns_binding, keyTeams.has(row.team_identifier));
  if (pushMethod === 'none') {
    if (bindingNamed) lower('degraded', `APNs binding ${row.apns_binding} is missing.`);
    else lower('configured', 'Push unavailable: no APNs binding or push key.');
  } else if (row.apns_health === 'failing') lower('failing', 'APNs is failing.');
  else if (row.apns_health === 'unknown') lower('configured', 'Push not checked yet.');
  return {
    id: `identity:${row.id}`,
    kind: 'identity',
    label: row.label,
    state,
    detail: notes.join(' ') || null,
    data: {
      source: row.source,
      passTypeIdentifier: row.pass_type_identifier,
      daysRemaining: days,
      apnsBinding: row.apns_binding,
      bindingPresent,
      pushMethod,
      apnsHealth: row.apns_health,
      orgId: row.org_id,
    },
  };
}
