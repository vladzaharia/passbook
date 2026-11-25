/**
 * The photo-led card (badge, credential, ID): front with the photo, name and details, back with the
 * code. Boxes in mm from the card's top-left corner, shared by the page and the PDF. Landscape and
 * portrait differ only here.
 */

import type { PaperContent } from '../../passkit/template/paper-content.ts';
import type { Box } from '../../passkit/template/paper-geometry.ts';
import { join } from './ticket-text-base.ts';
import { idDetails } from './ticket-text-kinds.ts';

export interface BadgeLayout {
  portrait: boolean;
  plate: Box;
  kicker: Box;
  photo: Box;
  name: Box & { lines: number; size: number };
  role: Box & { lines: number };
  details: Box & { lines: number };
  /** Back: the area the code is centred in, and the text beside or under it. */
  code: Box;
  note: Box;
}

/** The detail lines that fit between `top` and the card's bottom margin. */
const linesFrom = (top: number, h: number) => Math.max(1, Math.floor((h - 3.5 - top) / 3.1));

export function badgeLayout(w: number, h: number, roleLines = 1): BadgeLayout {
  const portrait = h > w;
  const roleH = 3.6 * roleLines + 0.4;
  if (portrait) {
    const top = 63.5 + roleH + 1.2;
    return {
      portrait,
      plate: { x: 4, y: 4, w: 8, h: 8 },
      kicker: { x: 15, y: 6.2, w: w - 19, h: 4 },
      photo: { x: (w - 34) / 2, y: 15, w: 34, h: 34 },
      name: { x: 4, y: 52.5, w: w - 8, h: 10, lines: 2, size: 4.4 },
      role: { x: 4, y: 63.5, w: w - 8, h: roleH, lines: roleLines },
      details: { x: 4, y: top, w: w - 8, h: h - 3.5 - top, lines: linesFrom(top, h) },
      code: { x: 4, y: 4, w: w - 8, h: 46 },
      note: { x: 4, y: 52, w: w - 8, h: h - 56 },
    };
  }
  const top = 26 + roleH + 1.2;
  return {
    portrait,
    plate: { x: 4, y: 4, w: 8, h: 8 },
    kicker: { x: 15, y: 6.2, w: w - 19, h: 4 },
    photo: { x: 4, y: 15, w: 31, h: 31 },
    name: { x: 39, y: 15, w: w - 43, h: 10, lines: 2, size: 4.4 },
    role: { x: 39, y: 26, w: w - 43, h: roleH, lines: roleLines },
    details: { x: 39, y: top, w: w - 43, h: h - 3.5 - top, lines: linesFrom(top, h) },
    code: { x: 4, y: 4, w: 45, h: h - 8 },
    note: { x: 52, y: 6, w: w - 56, h: h - 12 },
  };
}

/** What the front says: the name, the role line under it and the detail lines. */
export function badgeFront(c: PaperContent): { name: string; role?: string; details: string[] } {
  const d = idDetails(c);
  const role =
    c.kind === 'credential' ? c.info.credential : d.find((r) => r.label === 'Role')?.text;
  const rest = d.filter(
    (r) => r.label !== 'Role' && !(c.kind === 'credential' && r.label === 'Name'),
  );
  const lines = rest.filter((r) => r.label !== 'Holder').map((r) => `${r.label}: ${r.text}`);
  return {
    name: c.holder ?? c.title,
    ...(role ? { role: join(role) } : {}),
    details: lines,
  };
}
