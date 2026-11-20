import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react';

/** The glyph in a verdict's disc: strip, recent rows and the pass sheet. Shape says it without colour. */
export const DISC_GLYPH = {
  ok: Check,
  heads_up: TriangleAlert,
  refused: CircleAlert,
  system: Info,
} as const;
