import type { AccessManifest } from '../../../passkit/types.ts';
import type { ScanZone } from '../../../shared/contracts/scan-access.ts';
import type { ZoneRow } from './repo-zones.ts';

export interface AccessTemplateRow {
  id: string;
  name: string;
  manifest: string;
}

type PlanRef = ScanZone['plans'][number];

/**
 * The plans that open each zone: a grant naming the zone's key, a key above it, or every zone.
 * A grant that reads its key from a pass input names no zone here.
 */
export function plansByZone(
  zones: readonly ZoneRow[],
  templates: readonly AccessTemplateRow[],
): Map<string, PlanRef[]> {
  const byId = new Map(zones.map((z) => [z.id, z]));
  const keysAt = (zone: ZoneRow): Set<string> => {
    const keys = new Set<string>(['*']);
    const seen = new Set<string>();
    for (
      let at: ZoneRow | undefined = zone;
      at && !seen.has(at.id);
      at = byId.get(at.parentId ?? '')
    ) {
      keys.add(at.key);
      seen.add(at.id);
    }
    return keys;
  };
  const plans = templates.flatMap((t) => {
    const access = (JSON.parse(t.manifest) as { scan?: { access?: AccessManifest } }).scan?.access;
    return (access?.plans ?? []).map((p) => ({
      ref: { templateId: t.id, templateName: t.name, planId: p.id, label: p.label },
      keys: new Set(p.zones.flatMap((g) => (typeof g.zone === 'string' ? [g.zone] : []))),
    }));
  });
  return new Map(
    zones.map((z) => {
      const here = keysAt(z);
      return [z.id, plans.filter((p) => [...p.keys].some((k) => here.has(k))).map((p) => p.ref)];
    }),
  );
}
