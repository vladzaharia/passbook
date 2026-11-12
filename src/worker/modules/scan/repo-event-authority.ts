import type { Check } from '../../platform/authority-checks.ts';
import { releaseHead, rowIs } from '../../platform/authority-checks.ts';
import type { Mode } from '../../platform/authority-principal.ts';
import { templatesUsable } from './repo-admin-grant.ts';
import type { ConsoleEventRow } from './repo-events.ts';
import type { TemplateStamps } from './repo-scope-releases.ts';

/**
 * Every approved release an event's templates were validated against is still the head for this
 * organization and mode (create and edit only: a newer release does not unscope a scan). An
 * `archived` template already on the event has no issuance head; the caller pins it as archived.
 */
export const eventReleaseChecks = (
  stamps: TemplateStamps | undefined,
  mode: Mode,
  archived: readonly string[] = [],
): Check[] =>
  (stamps?.releases ?? [])
    .filter((s) => !archived.includes(s.templateId))
    .map((s) => releaseHead(s.templateId, mode, 'apple', s.id));

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
 * New templates must be active with an unchanged head. Templates already on the event stay usable
 * when archived (they keep scanning, with no issuance head to pin); deleted ones stop.
 */
export function attachedTemplateChecks(
  added: readonly string[],
  kept: readonly string[],
  archived: readonly string[],
  stamps: TemplateStamps | undefined,
  mode: Mode,
): Check[] {
  return [
    ...templatesUsable(added),
    ...templatesUsable(
      kept.filter((id) => !archived.includes(id)),
      'attached',
    ),
    ...templatesUsable(archived, 'archived'),
    ...eventReleaseChecks(stamps, mode, archived),
  ];
}
