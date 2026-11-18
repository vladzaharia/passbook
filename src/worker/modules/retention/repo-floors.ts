import type { Grant } from '../../platform/authority.ts';
import type { FloorWrite } from './changes.ts';

/**
 * Adds retention floor writes to a settings grant. An org grant supplies its own org. A platform grant (a
 * platform maximum or default moved) names the org each floor belongs to.
 */
export function addFloorWrites(g: Grant, floors: readonly FloorWrite[], platform: boolean): void {
  for (const f of floors) {
    if (f.change.kind === 'clear') {
      g.delete('retention_floors', {
        where: platform ? { org_id: f.orgId, class: f.cls } : { class: f.cls },
      });
    } else {
      const { days, until } = f.change;
      g.upsert(
        'retention_floors',
        platform ? ['org_id', 'class', 'days', 'until'] : ['class', 'days', 'until'],
        platform ? [f.orgId, f.cls, days, until] : [f.cls, days, until],
        { update: ['days', 'until'] },
      );
    }
  }
}
