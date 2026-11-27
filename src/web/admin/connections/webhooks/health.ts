import type { WebhookEndpointDto } from '@/shared/contracts/webhooks.ts';

export type EndpointState = 'active' | 'untested' | 'failing' | 'paused' | 'disabled';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** "3 h", "2 days": the coarsest unit that reads as a number above one. */
export function spanLabel(ms: number): string {
  if (ms < HOUR) return `${Math.max(1, Math.round(ms / MIN))} min`;
  if (ms < DAY) return `${Math.round(ms / HOUR)} h`;
  const days = Math.round(ms / DAY);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

export function endpointState(e: WebhookEndpointDto): EndpointState {
  if (e.status === 'disabled') return 'disabled';
  if (e.status === 'paused') return 'paused';
  if (e.failingSince !== null) return 'failing';
  return e.lastSuccessAt === null ? 'untested' : 'active';
}

/** The pill's words: "Failing for 3 h" counts from the first failure of the current run. */
export function stateLabel(e: WebhookEndpointDto, now: number): string {
  const state = endpointState(e);
  if (state === 'failing' && e.failingSince !== null)
    return `Failing for ${spanLabel(Math.max(0, now - e.failingSince))}`;
  return {
    active: 'Active',
    untested: 'Not tested',
    failing: 'Failing',
    paused: 'Paused',
    disabled: 'Disabled',
  }[state];
}

/** The kit status each endpoint state wears: failing is amber, never red (it may recover). */
export const STATE_STATUS = {
  active: 'verified',
  untested: 'not_configured',
  failing: 'degraded',
  paused: 'not_configured',
  disabled: 'disabled',
} as const;

/** Host and path tail for people; a manager's full URL stays in the form. */
export function endpointHost(e: Pick<WebhookEndpointDto, 'url' | 'urlMasked'>): string {
  if (e.url) {
    try {
      return new URL(e.url).host;
    } catch {
      /* fall through to the masked form */
    }
  }
  return e.urlMasked.split('/')[0] ?? e.urlMasked;
}

/** The last delivery's time and outcome from the endpoint's own counters. */
export function lastDelivery(
  e: WebhookEndpointDto,
): { at: number; ok: boolean; status: number | null } | null {
  const ok = e.lastSuccessAt;
  const bad = e.lastFailureAt;
  if (ok === null && bad === null) return null;
  if (bad !== null && (ok === null || bad > ok))
    return { at: bad, ok: false, status: e.lastStatus };
  return { at: ok as number, ok: true, status: e.lastStatus };
}
