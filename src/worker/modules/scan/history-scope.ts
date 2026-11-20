import type { ScanActor } from './actor.ts';

/**
 * A pass is in the actor's reach when its template is in the scope the actor was admitted with. A
 * scanner with no scope reads passes only when it accepts every template; a console actor has no
 * scope of its own. Anything else answers as a missing pass.
 */
export function passInScope(actor: ScanActor, templateId: string): boolean {
  if (actor.templateIds.length > 0) return actor.templateIds.includes(templateId);
  return !actor.scanner || actor.settings.acceptAllTemplates === true;
}
