import type { Grant } from '../../platform/authority.ts';
import { tenantSql } from '../../platform/authority-cond.ts';

/**
 * Clears the cached expected count of the mode's events that select the template: the release's
 * org's events, or every org's for a global template, as the grant's tenant sees them. Evaluated when the statement runs, so an event
 * that selects the template in the same batch is covered.
 */
export function invalidateEventCache(
  g: Grant,
  templateId: string,
  mode: string,
  orgId: string | null,
): void {
  g.update('scan_events', {
    set: { expected: null, expected_at: null },
    // An org grant supplies the org itself; a platform grant names it.
    where: g.scope === 'platform' && orgId !== null ? { mode, org_id: orgId } : { mode },
    when: [
      tenantSql(
        'EXISTS (SELECT 1 FROM scan_event_templates s WHERE s.event_id = {row}.id AND s.template_id = ?)',
        [templateId],
      ),
    ],
  });
}
