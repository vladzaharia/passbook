import type { Check } from '../../platform/authority-checks.ts';
import { releaseHead, rowIs } from '../../platform/authority-checks.ts';
import type { Mode } from '../../platform/authority-principal.ts';
import type { ConsoleEventRow } from './repo-events.ts';
import type { TemplateStamps } from './repo-scope-releases.ts';

/**
 * Every approved release an event's templates were validated against is still the head for this
 * organization and mode (create and edit only: a newer release does not unscope a scan).
 */
export const eventReleaseChecks = (stamps: TemplateStamps | undefined, mode: Mode): Check[] =>
  (stamps?.releases ?? []).map((s) => releaseHead(s.templateId, mode, 'apple', s.id));

/** A cache fill derived from this exact read of the event: same epoch, same cached value. */
export const eventCacheChecks = (row: ConsoleEventRow): Check[] => [
  rowIs(
    'scan_events',
    row.id,
    { config_epoch: row.configEpoch, expected_at: row.expectedAt },
    'config',
  ),
];
