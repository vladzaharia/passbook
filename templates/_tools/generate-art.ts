// Writes the artwork of the blueprints (templates/starter-*). Deterministic: same bytes every run.
// Usage: node templates/_tools/generate-art.ts [outDir] [slug]
// Logos are trimmed marks, thumbnails are rounded on transparent, motifs sit at the trailing or
// bottom edge (HIG, June 2026). @2x and @3x only. Then run `npm run gen`.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WHITE, PALETTE } from './math.ts';
import { icon, logo } from './marks.ts';
import { balanceStrip, couponStrip, genericThumb, routeFooter } from './painters-cards.ts';
import { accessThumb } from './painters-access.ts';
import {
  BOOKING, ID, PACK, PERMIT, PICKUP, TIMED, TRANSIT,
  bookingThumb, idThumb, packStrip, permitThumb, pickupThumb, timedStrip, transitFooter,
} from './painters-blueprints.ts';
import { hex } from './math.ts';
import { eventArt, eventBackground, eventThumb, posterArt } from './painters-scenes.ts';
import { type Painter, png } from './png.ts';

interface Slot {
  file: string;
  w: number;
  h: number;
  paint: Painter;
}

/** Slots per blueprint package. Add the stamp card's slots here when its painters exist. */
export const BLUEPRINTS: Record<string, Slot[]> = {
  'starter-generic': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.ink.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'thumbnail', w: 90, h: 90, paint: genericThumb },
  ],
  'starter-access-card': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.cobalt.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'thumbnail', w: 90, h: 90, paint: accessThumb },
  ],
  'starter-poster-generic': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.violet.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'primaryLogo', w: 30, h: 30, paint: logo(WHITE) },
    { file: 'artwork', w: 358, h: 448, paint: posterArt },
  ],
  'starter-event-ticket': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.berry.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'primaryLogo', w: 30, h: 30, paint: logo(WHITE) },
    { file: 'secondaryLogo', w: 12, h: 12, paint: logo(WHITE) },
    { file: 'artwork', w: 358, h: 448, paint: eventArt },
    { file: 'background', w: 343, h: 503, paint: eventBackground },
    { file: 'thumbnail', w: 90, h: 90, paint: eventThumb },
  ],
  'starter-coupon': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.tangerine.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'strip', w: 375, h: 144, paint: couponStrip },
  ],
  'starter-boarding-pass': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.sky.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'primaryLogo', w: 30, h: 30, paint: logo(WHITE) },
    { file: 'footer', w: 268, h: 15, paint: routeFooter },
  ],
  'starter-store-card': [
    { file: 'icon', w: 38, h: 38, paint: icon(PALETTE.teal.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'strip', w: 375, h: 144, paint: balanceStrip },
  ],
  'starter-pack': [
    { file: 'icon', w: 38, h: 38, paint: icon(PACK.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'strip', w: 375, h: 144, paint: packStrip },
  ],
  'starter-timed-ticket': [
    { file: 'icon', w: 38, h: 38, paint: icon(TIMED.bg, hex('#FFF8E7')) },
    { file: 'logo', w: 50, h: 50, paint: logo(hex('#FFF8E7')) },
    { file: 'strip', w: 375, h: 144, paint: timedStrip },
  ],
  'starter-transit-ticket': [
    { file: 'icon', w: 38, h: 38, paint: icon(TRANSIT.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'footer', w: 268, h: 15, paint: transitFooter },
  ],
  'starter-booking': [
    { file: 'icon', w: 38, h: 38, paint: icon(BOOKING.bg, BOOKING.fg) },
    { file: 'logo', w: 50, h: 50, paint: logo(BOOKING.fg) },
    { file: 'thumbnail', w: 90, h: 90, paint: bookingThumb },
  ],
  'starter-pickup': [
    { file: 'icon', w: 38, h: 38, paint: icon(PICKUP.bg, PICKUP.fg) },
    { file: 'logo', w: 50, h: 50, paint: logo(PICKUP.fg) },
    { file: 'thumbnail', w: 90, h: 90, paint: pickupThumb },
  ],
  'starter-permit': [
    { file: 'icon', w: 38, h: 38, paint: icon(PERMIT.bg) },
    { file: 'logo', w: 50, h: 50, paint: logo(WHITE) },
    { file: 'thumbnail', w: 90, h: 90, paint: permitThumb },
  ],
  'starter-id-card': [
    { file: 'icon', w: 38, h: 38, paint: icon(ID.bg, ID.fg) },
    { file: 'logo', w: 50, h: 50, paint: logo(ID.fg) },
    { file: 'thumbnail', w: 90, h: 90, paint: idThumb },
  ],
};

const STALE = ['', '@2x', '@3x'].flatMap((x) =>
  ['icon', 'logo', 'primaryLogo', 'secondaryLogo', 'thumbnail', 'strip', 'artwork', 'background', 'footer'].map(
    (f) => `${f}${x}.png`,
  ),
);

const out = process.argv[2] ?? join(import.meta.dirname, '..');
const only = process.argv[3];
for (const [slug, slots] of Object.entries(BLUEPRINTS)) {
  if (only && slug !== only) continue;
  const dir = join(out, slug);
  mkdirSync(dir, { recursive: true });
  for (const name of STALE) rmSync(join(dir, name), { force: true });
  for (const slot of slots)
    for (const scale of [2, 3]) {
      const file = join(dir, `${slot.file}@${scale}x.png`);
      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, png(slot.w, slot.h, scale, slot.paint));
    }
  console.log(slug, slots.length * 2, 'files');
}
