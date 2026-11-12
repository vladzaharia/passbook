import { ENTITY } from '../../lib/entities.ts';
import type { Swatch } from '../../lib/swatches.ts';

/** Extra match terms: "new" lists every create action, Upload template included. */
export const ACTION_KEYWORDS: Record<string, string[]> = {
  'new-pass': ['create', 'add'],
  'upload-template': ['new', 'create', 'add', 'import'],
  'new-connection': ['create', 'add'],
  'new-org': ['create', 'add', 'tenant'],
  'new-key': ['create', 'add'],
  'new-scanner': ['create', 'add', 'pair', 'device'],
  'switch-org': ['organization', 'scope'],
};

/** A pass row shows the pass in miniature (its image over its colour), else the pass glyph. */
export function chip(
  swatch: Swatch | undefined,
): { swatch: string } | { icon: typeof ENTITY.pass.icon } {
  if (!swatch) return { icon: ENTITY.pass.icon };
  return {
    swatch: swatch.image
      ? `center / cover url("${swatch.image}"), ${swatch.background}`
      : swatch.background,
  };
}
