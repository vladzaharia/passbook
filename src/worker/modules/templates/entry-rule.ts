import type { TemplateManifest } from '../../../passkit/types.ts';
import type { EntryRule } from '../../../shared/contracts/template-releases.ts';
import { scanOf } from '../../../shared/scan-defaults.ts';

/** The pass type's check-in rule, from its release manifest; null when it has no check-in action. */
export function entryRuleOf(manifest: TemplateManifest): EntryRule | null {
  const scan = scanOf(manifest);
  const action = scan.actions.find((a) => a.kind === 'check_in');
  if (!action) return null;
  const own = scan.checkIn;
  const mode =
    own?.mode ??
    (action.repeat === 'once' ? 'single' : action.repeat === 'daily' ? 'daily' : 'unlimited');
  return {
    mode,
    days: own?.days ?? null,
    durationMinutes: own?.durationMinutes ?? null,
    durationFrom: own?.durationFrom ?? null,
    plans: [...new Set(scan.access?.plans.map((p) => p.kind) ?? [])],
    source: own ? 'template' : 'action',
  };
}
