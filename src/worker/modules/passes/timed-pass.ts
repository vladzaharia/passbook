import type { UpcomingEventsConfig } from '../../../passkit/behaviors/upcoming-events/index.ts';
import { retimePass } from '../../../passkit/behaviors/upcoming-events/timed.ts';
import { DEFAULT_EVENT_MINUTES } from '../../../passkit/boundaries.ts';
import { applyDefaults } from '../../../passkit/template/manifest.ts';
import type { ResolvedTemplate } from '../../../passkit/template/registry.ts';
import type { PassJson, Personalization } from '../../../passkit/types.ts';

/** The template's upcoming-events config; null when its events, if any, do not move with the clock. */
export function eventsConfig(template: ResolvedTemplate): UpcomingEventsConfig | null {
  const use = template.manifest.behaviors?.find((b) => b.use === 'upcoming-events');
  return use ? (use.config as unknown as UpcomingEventsConfig) : null;
}

/** How long an event without an end runs on this template. */
export function eventMinutes(template: ResolvedTemplate): number {
  const minutes = eventsConfig(template)?.fallbackMinutes;
  return typeof minutes === 'number' ? minutes : DEFAULT_EVENT_MINUTES;
}

/**
 * A built pass.json as a wallet shows it at `at`: the upcoming events' timed keys worked out then
 * (docs/design/event-boundaries.md). As built when the template's events do not move with the clock.
 */
export function timedPassJson(
  built: PassJson,
  personalization: Personalization,
  template: ResolvedTemplate,
  at: number,
): PassJson {
  const config = eventsConfig(template);
  if (!config) return built;
  const input = applyDefaults(template.manifest, personalization);
  return retimePass(built, input, config, template.manifest.lookups ?? {}, at);
}
