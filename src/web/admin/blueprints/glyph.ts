import { DraftingCompass, type LucideIcon } from 'lucide-react';
import { scanIcon } from '@/web/scan/display/icons.ts';

/** The blueprint's `display.icon` from the curated set; a blueprint without one gets the compass. */
export function blueprintGlyph(b: { icon: string | null }): LucideIcon {
  return scanIcon(b.icon) ?? DraftingCompass;
}
