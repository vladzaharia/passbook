import type { ValidationIssue } from '../../../../passkit/types.ts';
import { isPngInfo, parsePng } from './png.ts';
import { checkSize, type SlotName } from './slots.ts';

/** Optional image backend (the Images binding in the Worker). Absent in codegen and some tests. */
export interface ImageTools {
  /** Returns null when the backend is unavailable; throws ImageInvalid for non-images. */
  info?(bytes: Uint8Array): Promise<{ width: number; height: number; format: string } | null>;
  /** Resizes to exact pixels as PNG. Returns null when unavailable. */
  resize?(bytes: Uint8Array, width: number, height: number): Promise<Uint8Array | null>;
}

export class ImageInvalid extends Error {}

export interface ImageFile {
  path: string;
  slot: SlotName;
  scale: 1 | 2 | 3;
  locale?: string;
  bytes: Uint8Array;
}

export interface CheckedImage extends ImageFile {
  width: number;
  height: number;
}

type Issue = (issue: ValidationIssue) => void;

/** Structure (IHDR + chunk walk), the backend decode check when available, then slot dimensions. */
export async function checkImage(
  file: ImageFile,
  tools: ImageTools,
  push: Issue,
): Promise<CheckedImage | null> {
  const png = parsePng(file.bytes);
  if (!isPngInfo(png)) {
    push({ severity: 'error', code: 'IMAGE_INVALID', message: png.error, path: file.path });
    return null;
  }
  if (tools.info) {
    try {
      const decoded = await tools.info(file.bytes);
      if (decoded && decoded.format !== 'image/png') {
        push({
          severity: 'error',
          code: 'IMAGE_FORMAT',
          message: 'Image must be a PNG.',
          path: file.path,
        });
        return null;
      }
      if (decoded && (decoded.width !== png.width || decoded.height !== png.height)) {
        push({
          severity: 'error',
          code: 'IMAGE_INVALID',
          message: 'Image header does not match its content.',
          path: file.path,
        });
        return null;
      }
    } catch (error) {
      if (error instanceof ImageInvalid) {
        push({
          severity: 'error',
          code: 'IMAGE_INVALID',
          message: 'Image cannot be decoded.',
          path: file.path,
        });
        return null;
      }
      throw error;
    }
  }
  const problem = checkSize(file.path, file.slot, file.scale, png.width, png.height);
  if (problem) {
    push({
      severity: problem.level,
      code: 'IMAGE_SIZE',
      message: problem.message,
      path: file.path,
    });
    if (problem.level === 'error') return null;
  }
  return { ...file, width: png.width, height: png.height };
}

function pathFor(file: CheckedImage, scale: 1 | 2 | 3): string {
  const dir = file.locale ? `${file.locale}.lproj/` : '';
  return `${dir}${file.slot}${scale === 1 ? '' : `@${scale}x`}.png`;
}

/**
 * Fills a missing @2x from the @3x source (signed packages carry @2x and @3x only, so @1x is never
 * needed). Returns the new files; warns when that is impossible.
 */
export async function deriveScales(
  images: CheckedImage[],
  tools: ImageTools,
  push: Issue,
): Promise<CheckedImage[]> {
  const groups = new Map<string, CheckedImage[]>();
  for (const image of images) {
    const key = `${image.locale ?? ''}|${image.slot}`;
    groups.set(key, [...(groups.get(key) ?? []), image]);
  }
  const derived: CheckedImage[] = [];
  for (const group of groups.values()) {
    const source = group.find((g) => g.scale === 3);
    for (const scale of [2] as const) {
      if (group.some((g) => g.scale === scale)) continue;
      const first = group[0] as CheckedImage;
      const path = pathFor(first, scale);
      if (!source) {
        if (first.slot === 'icon' && !group.some((g) => g.scale === 3))
          push({
            severity: 'warning',
            code: 'IMAGE_SCALE_MISSING',
            message: `${path} is missing.`,
            path,
          });
        continue;
      }
      const width = Math.round((source.width * scale) / 3);
      const height = Math.round((source.height * scale) / 3);
      const bytes = await tools.resize?.(source.bytes, width, height);
      if (!bytes) {
        push({
          severity: 'warning',
          code: 'IMAGE_SCALE_MISSING',
          message: `${path} is missing and cannot be derived here.`,
          path,
        });
        continue;
      }
      const checked = await checkImage({ ...source, path, scale, bytes }, {}, push);
      if (!checked) continue;
      push({
        severity: 'warning',
        code: 'IMAGE_DERIVED',
        message: `${path} derived from the @3x image.`,
        path,
      });
      derived.push(checked);
    }
  }
  return derived;
}
