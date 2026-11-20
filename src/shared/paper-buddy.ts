/**
 * The PassBook buddy as a static cameo on paper (design-paper-ticket.md, Buddy). The geometry is the
 * product's (web/ui/art/wallet.tsx: pass card, body, stitch, screen, eyes, smile, joy eyes, seated
 * legs, the confirm check) drawn once, with no foil, shadow or motion. Plain data so the print page
 * and the PDF draw the same paths.
 */
export type BuddyPose = 'wave' | 'happy' | 'coupon' | 'ready';

/** viewBox of the art: the 96 x 80 area that holds the lifted pass. */
export const BUDDY_VIEWBOX = '0 -4 96 80';
export const BUDDY_RATIO = 80 / 96;
/** Allowed width on paper, mm. */
export const BUDDY_MM = { default: 13, min: 10, max: 14 } as const;
export const BUDDY_LINE = 2.4;

export const BUDDY_PATHS = {
  card: 'M40 9h16a3 3 0 0 1 3 3v25a3 3 0 0 1-3 3H40a3 3 0 0 1-3-3V12a3 3 0 0 1 3-3Z',
  legLeft: 'M35 60h5v10.5a2.5 2.5 0 0 1-2.5 2.5h-3a2 2 0 0 1 0-4h.5Z',
  legRight: 'M56 60h5v9h.5a2 2 0 0 1 0 4h-3a2.5 2.5 0 0 1-2.5-2.5Z',
  joy: 'M41.8 44.4q1.7-2.4 3.4 0M50.8 44.4q1.7-2.4 3.4 0',
  smile: 'M45.5 47.5q2.5 2 5 0',
  bigSmile: 'M45 47.2q3 2.6 6 0',
  highlight: 'M41 14h9',
  percent: ['M44 30l8-14'],
  check: 'M43.5 20l3 3 6-6.5',
} as const;

export interface BuddyPalette {
  body: string;
  line: string;
  face: string;
  passes: [string, string, string];
  screen: string;
  screenFill: string;
  highlight: string;
  mark: string;
}

/** Colour in the light-theme tokens; mono is black outlines, white passes, black face. */
export function buddyPalette(mono: boolean): BuddyPalette {
  return mono
    ? {
        body: '#fff',
        line: '#000',
        face: '#000',
        passes: ['#fff', '#fff', '#fff'],
        screen: '#000',
        screenFill: 'none',
        highlight: 'none',
        mark: '#000',
      }
    : {
        body: '#fff',
        line: '#7E8699',
        face: '#060912',
        passes: ['#0F766E', '#7A2FFF', '#D07A00'],
        screen: '#0F766E',
        screenFill: 'rgb(15 118 110/.2)',
        highlight: 'rgb(255 255 255/.55)',
        mark: '#fff',
      };
}

/** Whether the happy eyes (smiling shut) are drawn, the left pass raised and the top pass lifted. */
export const BUDDY_POSES: Record<
  BuddyPose,
  { joy: boolean; wave: boolean; lift: number; bigSmile: boolean }
> = {
  wave: { joy: false, wave: true, lift: 0, bigSmile: false },
  happy: { joy: true, wave: false, lift: 0, bigSmile: true },
  coupon: { joy: false, wave: false, lift: 6, bigSmile: true },
  ready: { joy: true, wave: false, lift: 6, bigSmile: false },
};
