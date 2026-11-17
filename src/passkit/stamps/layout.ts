// Stamp grid geometry, in points. One function for the pass strip, the designer preview and the
// scanner's stamp row (proposed home: src/shared/stamps/layout.ts). Pure arithmetic: no trig,
// no sqrt, so the result is identical in workerd, Node and every browser.

import { GOAL_MAX, GOAL_MIN } from './goal.ts';

export { GOAL_MAX, GOAL_MIN };

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** storeCard strip, 375 x 144 pt. */
export const STRIP = { w: 375, h: 144 } as const;
/**
 * Where discs may sit: 16 pt side margins, and the 102 pt band (y 21-123) that survives the
 * ~100 pt centred crop of short layouts and the web preview.
 */
export const STRIP_SAFE: Box = { x: 16, y: 21, w: 343, h: 102 };

export interface StampCell {
  /** 0-based position; the last one is the reward. */
  index: number;
  row: number;
  /** Centre, points. */
  cx: number;
  cy: number;
  /** Disc diameter, points. */
  d: number;
  /** Fixed tilt in whole degrees (position-based, never random). */
  tilt: number;
  /** Small fixed offset of a filled stamp, points (a hand-pressed look). */
  jx: number;
  jy: number;
  reward: boolean;
}

export interface StampGrid {
  goal: number;
  rows: number[];
  d: number;
  gapX: number;
  gapY: number;
  cells: StampCell[];
}

export interface GridOptions {
  /** Largest disc, points. */
  dMax?: number;
  /** Rows by goal; defaults to the strip rule. */
  rows?: (goal: number) => number;
}

/** Strip rule: 3-6 one row, 7-18 two rows, 19-20 three rows. */
export function stripRows(goal: number): number {
  return goal <= 6 ? 1 : goal <= 18 ? 2 : 3;
}

/** Discs per row, longest first: 7 -> [4, 3], 20 -> [7, 7, 6]. */
export function rowSplit(goal: number, rows: number): number[] {
  const base = Math.floor(goal / rows);
  const extra = goal % rows;
  return Array.from({ length: rows }, (_, r) => base + (r < extra ? 1 : 0));
}

// Gaps as a share of the disc: the blueprint's 44 pt discs, 20 pt apart, 14 pt between rows.
const GAP_X = 20 / 44;
const GAP_Y = 14 / 44;
const GAP_X_MAX = 0.5;
const GAP_Y_MAX = 0.5;

// Tilt and nudge per position. Integer degrees index a literal cos/sin table (compose.ts).
const TILT = [-9, 6, -3, 11, -7, 4, -12, 8, -5, 10, -4, 7, -10, 3, -6, 12, -8, 5, -11, 0];
const NUDGE: [number, number][] = [
  [0.8, -0.6],
  [-0.7, 0.5],
  [0.4, 0.9],
  [-0.9, -0.4],
  [0.6, 0.3],
  [-0.4, -0.8],
  [0.9, 0.5],
  [-0.6, 0.7],
  [0.3, -0.5],
  [-0.8, 0.2],
  [0.5, 0.8],
  [-0.3, -0.9],
  [0.7, -0.2],
  [-0.5, 0.6],
  [0.2, 0.4],
  [-0.9, -0.3],
  [0.6, -0.7],
  [-0.2, 0.9],
  [0.8, 0.1],
  [0, 0],
];

/** Snaps to 1/6 pt: a whole pixel at @2x and @3x alike. */
const snap = (v: number) => Math.round(v * 6) / 6;

export function stampGrid(
  goal: number,
  box: Box = STRIP_SAFE,
  options: GridOptions = {},
): StampGrid {
  if (!Number.isInteger(goal) || goal < GOAL_MIN || goal > GOAL_MAX)
    throw new RangeError(`Goal must be ${GOAL_MIN} to ${GOAL_MAX}.`);
  const dMax = options.dMax ?? 56;
  const rows = rowSplit(goal, (options.rows ?? stripRows)(goal));
  const r = rows.length;
  const cols = rows[0] as number;
  const dW = box.w / (cols + (cols - 1) * GAP_X);
  const dH = box.h / (r + (r - 1) * GAP_Y);
  const d = snap(Math.min(dMax, dW, dH));
  const gapX = cols > 1 ? Math.min(GAP_X_MAX * d, (box.w - cols * d) / (cols - 1)) : 0;
  const gapY = r > 1 ? Math.min(GAP_Y_MAX * d, Math.max(GAP_Y * d, (box.h - r * d) / (r - 1))) : 0;
  const height = r * d + (r - 1) * gapY;
  const y0 = box.y + (box.h - height) / 2 + d / 2;
  const k = d / 44;
  const cells: StampCell[] = [];
  let index = 0;
  rows.forEach((n, row) => {
    const width = n * d + (n - 1) * gapX;
    const x0 = box.x + (box.w - width) / 2 + d / 2;
    for (let c = 0; c < n; c++, index++) {
      const reward = index === goal - 1;
      const [jx, jy] = NUDGE[index] as [number, number];
      cells.push({
        index,
        row,
        cx: snap(x0 + c * (d + gapX)),
        cy: snap(y0 + row * (d + gapY)),
        d,
        tilt: reward ? 0 : (TILT[index] as number),
        jx: reward ? 0 : snap(jx * k),
        jy: reward ? 0 : snap(jy * k),
        reward,
      });
    }
  });
  return { goal, rows, d, gapX, gapY, cells };
}

/** A scanner panel is "compact" under 400 px (a phone), "wide" from 400 (iPad). */
export const SCAN_WIDE = 400;

/**
 * The scanner's stamp row: the pass's rows on a phone, one row up to 10 on a wide panel. Discs up
 * to 44 px, at least 8 apart, spread up to 32 apart; 10 between rows. Flat icons: no tilt.
 */
export function scanGrid(goal: number, width: number): StampGrid {
  if (!Number.isInteger(goal) || goal < GOAL_MIN || goal > GOAL_MAX)
    throw new RangeError(`Goal must be ${GOAL_MIN} to ${GOAL_MAX}.`);
  const rows = rowSplit(goal, width >= SCAN_WIDE ? (goal <= 10 ? 1 : 2) : stripRows(goal));
  const cols = rows[0] as number;
  const d = Math.min(44, Math.floor((width - (cols - 1) * 8) / cols));
  const gapX = cols > 1 ? Math.min(32, (width - cols * d) / (cols - 1)) : 0;
  const gapY = 10;
  const cells: StampCell[] = [];
  let index = 0;
  rows.forEach((n, row) => {
    const x0 = (width - (n * d + (n - 1) * gapX)) / 2 + d / 2;
    for (let c = 0; c < n; c++, index++)
      cells.push({
        index,
        row,
        cx: x0 + c * (d + gapX),
        cy: d / 2 + row * (d + gapY),
        d,
        tilt: 0,
        jx: 0,
        jy: 0,
        reward: index === goal - 1,
      });
  });
  return { goal, rows, d, gapX, gapY, cells };
}

/** Height of the scanner grid, px: 2 rows fit the progress row's 3 units, 3 rows take 4. */
export const scanGridHeight = (g: StampGrid) => g.rows.length * g.d + (g.rows.length - 1) * g.gapY;
