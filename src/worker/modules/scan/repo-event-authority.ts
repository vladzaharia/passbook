import type { Check } from '../../platform/authority-checks.ts';
import { releaseHead, rowIs } from '../../platform/authority-checks.ts';
import type { Mode } from '../../platform/authority-principal.ts';
import { templatesUsable } from './repo-admin-grant.ts';
import type { ConsoleEventRow } from './repo-events.ts';
import type { TemplateStamps } from './repo-scope-releases.ts';
import { tagged } from './setup-check-merge.ts';

/**
 * Every approved release an event's templates were validated against is still the head for this
 * organization and mode (create and edit only: a newer release does not unscope a scan). A template
 * already on the event (`kept`) keeps its head while archived; a new one needs an active template.
 */
export const eventReleaseChecks = (
  stamps: TemplateStamps | undefined,
  mode: Mode,
  kept: readonly string[] = [],
): Check[] =>
  (stamps?.releases ?? []).map((s) => {
    const status = kept.includes(s.templateId) ? 'existing' : 'issue';
    return tagged(
      releaseHead(s.templateId, mode, 'apple', s.id, status),
      `release:${s.templateId}:${s.id}:${status}`,
    );
  });

/** A cache fill derived from this exact read of the event: same epoch, same cached value. */
export const eventCacheChecks = (row: ConsoleEventRow): Check[] => [
  rowIs(
    'scan_events',
    row.id,
    { config_epoch: row.configEpoch, expected_at: row.expectedAt },
    'config',
  ),
];

/**
 * New templates must be active with an unchanged head. Templates already on the event keep scanning
 * with an unchanged head while archived; deleted ones stop (the issued-release rule, `releaseHead`).
 */
export function attachedTemplateChecks(
  added: readonly string[],
  kept: readonly string[],
  stamps: TemplateStamps | undefined,
  mode: Mode,
): Check[] {
  return [
    ...templatesUsable(added),
    ...templatesUsable(kept, 'attached'),
    ...eventReleaseChecks(stamps, mode, kept),
  ];
}
