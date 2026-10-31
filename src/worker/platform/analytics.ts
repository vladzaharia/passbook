import type { AppEnv } from './env.ts';

export type EventName =
  | 'pass.issued'
  | 'pass.updated'
  | 'pass.downloaded'
  | 'pass.registered'
  | 'pass.unregistered'
  | 'push.result'
  | 'email.result'
  | 'sync.run'
  | 'refresh.requested'
  | 'auth.sign_in';

export interface AnalyticsEvent {
  event: EventName;
  orgId?: string | null;
  templateId?: string | null;
  identityId?: string | null;
  outcome?: string;
  /** Numeric payload, e.g. duration in ms or a count. */
  value?: number;
}

/** Writes one data point; never throws and never blocks the request. */
export function writeEvent(env: Pick<AppEnv, 'EVENTS'>, event: AnalyticsEvent): void {
  try {
    env.EVENTS?.writeDataPoint({
      indexes: [event.orgId ?? 'platform'],
      blobs: [
        event.event,
        event.orgId ?? '',
        event.templateId ?? '',
        event.identityId ?? '',
        event.outcome ?? 'ok',
      ],
      doubles: [event.value ?? 1],
    });
  } catch {
    // Metrics are best-effort.
  }
}
