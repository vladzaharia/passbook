import type { ServiceContext } from '../../platform/service-context.ts';
import type { lastIdentityCheck } from '../identities/check.ts';
import { apnsBindingPresent } from '../identities/db-resolver.ts';
import { pushMethodOf } from '../identities/push-method.ts';
import type { IdentityRow } from '../identities/repo.ts';
import { type Draft, type State, worst } from './checks.ts';

const DAY = 86_400_000;

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
  else if (days !== null && days <= 30)
    lower('degraded', `${days} ${days === 1 ? 'day' : 'days'} left.`);
  if (check && !check.ok) lower('failing', `Key check failed: ${check.code ?? 'unknown'}.`);
  if (row.source === 'db' && !check) lower('configured', 'Not checked yet.');
  const pushMethod = pushMethodOf(ctx.env, row.apns_binding, keyTeams.has(row.team_identifier));
  if (pushMethod === 'none') {
    if (bindingNamed) lower('degraded', `APNs binding ${row.apns_binding} is missing.`);
    else lower('configured', 'Push unavailable: no APNs binding or push key.');
  } else if (row.apns_health === 'failing') lower('degraded', 'APNs is failing.');
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
