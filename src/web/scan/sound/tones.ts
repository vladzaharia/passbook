import type { Tone } from '../machine/types.ts';

/** wave, Hz, glide-to Hz (0 holds), start ms, length ms, gain (BM 12.2). */
export type Note = readonly [OscillatorType, number, number, number, number, number];

export const TONES: Record<Tone, readonly Note[]> = {
  ok: [['sine', 1175, 1568, 0, 110, 0.5]],
  reward: [
    ['sine', 1175, 1568, 0, 90, 0.5],
    ['sine', 1397, 0, 90, 70, 0.45],
    ['sine', 1760, 2093, 160, 140, 0.45],
  ],
  heads_up: [
    ['triangle', 784, 0, 0, 90, 0.5],
    ['triangle', 784, 0, 150, 90, 0.5],
  ],
  refused: [
    ['triangle', 262, 220, 0, 140, 0.6],
    ['triangle', 247, 196, 210, 160, 0.6],
  ],
  system: [
    ['sine', 523, 0, 0, 100, 0.45],
    ['sine', 392, 0, 120, 120, 0.45],
  ],
  undo: [['sine', 880, 660, 0, 60, 0.25]],
  read: [['sine', 2000, 0, 0, 25, 0.12]],
};

export const GARNISH = {
  thump: ['triangle', 180, 90, 0, 60, 0.5],
  click: ['square', 3200, 0, 0, 18, 0.06],
} as const satisfies Record<string, Note>;
export type Garnish = keyof typeof GARNISH;
