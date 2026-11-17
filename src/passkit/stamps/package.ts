import type { StampsManifest, ValidationIssue } from '../types.ts';
import type { StampArt } from './compose.ts';
import { STRIP } from './layout.ts';
import { decodePng, type Rgba } from './png.ts';
import { isGoal } from './rules.ts';
import { type StampStrip, stampStrips } from './strips.ts';

const ART_MIN = 128;
const ART_MAX = 1000;
const ART_SMALL = 256;
const CONTRAST_MIN = 3;

export interface StampFiles {
  strips: StampStrip[];
  issues: ValidationIssue[];
}

/** Every file name the block reads: its art, then the template's own strip at both scales. */
export const stampArtNames = (block: StampsManifest): string[] =>
  [block.art.filled, block.art.empty, block.art.reward, block.art.rewardEarned].filter(
    (n): n is string => typeof n === 'string',
  );

const channel = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const luminance = (r: number, g: number, b: number) =>
  0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** Mean colour of the pixels whose alpha is at least `min` (0 to 255), as relative luminance. */
function meanLuminance(img: Rgba, min: number): number | null {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4)
    if ((img.data[i + 3] as number) >= min) {
      r += img.data[i] as number;
      g += img.data[i + 1] as number;
      b += img.data[i + 2] as number;
      n++;
    }
  return n === 0 ? null : luminance(r / n, g / n, b / n);
}

export function contrastRatio(a: number, b: number): number {
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

export interface RenderStampOptions {
  /** Draw only these counts (the designer's dry run). Default every count. */
  counts?: readonly number[];
}

/**
 * Decodes the block's art and the base strips from the package files and draws every strip pair.
 * Problems come back as issues; with an error, `strips` is empty.
 */
export function renderStampFiles(
  block: StampsManifest,
  files: ReadonlyMap<string, Uint8Array> | Record<string, Uint8Array>,
  options: RenderStampOptions = {},
): StampFiles {
  // A bad goal or art list is the manifest check's to report (stampsIssues).
  if (
    !isGoal(block.goal) ||
    typeof block.art?.filled !== 'string' ||
    typeof block.art.empty !== 'string'
  )
    return { strips: [], issues: [] };
  const get = (name: string) =>
    files instanceof Map ? files.get(name) : (files as Record<string, Uint8Array>)[name];
  const issues: ValidationIssue[] = [];
  const fail = (code: string, message: string, path: string) =>
    issues.push({ severity: 'error', code, message, path });
  const warn = (code: string, message: string, path: string) =>
    issues.push({ severity: 'warning', code, message, path });

  const decoded = new Map<string, Rgba>();
  const load = (name: string | undefined, required: boolean): Rgba | undefined => {
    if (!name) return undefined;
    const bytes = get(name);
    if (!bytes) {
      if (required) fail('STAMPS_ART', `Add ${name}.`, name);
      return undefined;
    }
    try {
      const img = decodePng(bytes);
      if (img.width !== img.height || img.width < ART_MIN || img.width > ART_MAX)
        fail('STAMPS_ART_SIZE', `${name} must be a square PNG, ${ART_MIN} to ${ART_MAX} px.`, name);
      else if (img.width < ART_SMALL)
        warn('STAMPS_ART_SMALL', `${name} is under ${ART_SMALL} px; stamps may look soft.`, name);
      decoded.set(name, img);
      return img;
    } catch (error) {
      fail(
        'STAMPS_ART_SIZE',
        `${name}: ${error instanceof Error ? error.message : 'Not a PNG.'}`,
        name,
      );
      return undefined;
    }
  };
  const filled = load(block.art.filled, true);
  const empty = load(block.art.empty, true);
  const reward = load(block.art.reward, false);
  const rewardEarned = load(block.art.rewardEarned, false);

  const base: Partial<Record<2 | 3, Rgba>> = {};
  for (const scale of [2, 3] as const) {
    const name = `strip@${scale}x.png`;
    const bytes = get(name);
    if (!bytes) continue;
    try {
      const img = decodePng(bytes);
      if (img.width !== STRIP.w * scale || img.height !== STRIP.h * scale)
        fail(
          'STAMPS_STRIP_SIZE',
          'With stamps, the strip must be 750 × 288 (@2x) and 1125 × 432 (@3x).',
          name,
        );
      else base[scale] = img;
    } catch {
      fail('STAMPS_STRIP_SIZE', `${name} is not a readable PNG.`, name);
    }
  }
  if (issues.some((i) => i.severity === 'error') || !filled || !empty)
    return { strips: [], issues };

  const bg = base[2] ? meanLuminance(base[2], 255) : null;
  const fg = meanLuminance(filled, 200);
  if (bg !== null && fg !== null && contrastRatio(bg, fg) < CONTRAST_MIN)
    warn(
      'STAMPS_CONTRAST',
      `Filled stamps are hard to see on the strip (${contrastRatio(bg, fg).toFixed(1)}:1).`,
      block.art.filled,
    );

  const art: StampArt = {
    filled,
    empty,
    ...(reward ? { reward } : {}),
    ...(rewardEarned ? { rewardEarned } : {}),
  };
  const strips = stampStrips({
    goal: block.goal,
    art,
    base,
    ...(block.tilt === false ? { tilt: false } : {}),
    ...(options.counts ? { counts: options.counts } : {}),
  });
  return { strips, issues };
}
