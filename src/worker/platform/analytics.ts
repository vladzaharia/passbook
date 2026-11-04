import type { AppEnv } from './env.ts';
import { createLogger, type Logger } from './log.ts';

const fallbackLog = createLogger({ component: 'analytics' });

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
  /** The pass's mode; metrics split on it. Default live. */
  mode?: 'live' | 'test';
  /** Numeric payload, e.g. duration in ms or a count. */
  value?: number;
}

/**
 * Writes one data point; never throws and never blocks the request. A failed write (for example
 * past the 250 data point per invocation limit) logs `analytics.write_failed` with code AE_WRITE.
 */
export function writeEvent(
  env: Pick<AppEnv, 'EVENTS'>,
  event: AnalyticsEvent,
  log: Logger = fallbackLog,
): void {
  try {
    env.EVENTS?.writeDataPoint({
      indexes: [event.orgId ?? 'platform'],
      blobs: [
        event.event,
        event.orgId ?? '',
        event.templateId ?? '',
        event.identityId ?? '',
        event.outcome ?? 'ok',
        event.mode ?? 'live',
      ],
      doubles: [event.value ?? 1],
    });
  } catch (error) {
    log.warn('analytics.write_failed', { code: 'AE_WRITE', name: event.event, error });
  }
}
