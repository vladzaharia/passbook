import type { BehaviorRegistry } from '../../../../passkit/behaviors/registry.ts';
import { pixelIssues } from '../../../../passkit/schema/image-pixels.ts';
import type {
  AssetEntry,
  PassJson,
  PassStyle,
  TemplateManifest,
  ValidationIssue,
  ValidationReport,
} from '../../../../passkit/types.ts';
import { contentVersion, crc32, sha1Hex } from './hash.ts';
import {
  type CheckedImage,
  checkImage,
  deriveScales,
  type ImageFile,
  type ImageTools,
} from './images.ts';
import { defaultManifest, validateManifest } from './manifest.ts';
import { classify } from './names.ts';
import { stylesOf, usedSlots } from './slots.ts';
import { decodeStrings, parseStrings } from './strings.ts';

export const MAX_PASS_JSON_BYTES = 64 * 1024;
const STRIPPED_KEYS = ['serialNumber', 'authenticationToken', 'webServiceURL'] as const;

/** Asset metadata without a storage location; the caller decides where bytes live. */
export type AnalyzedAsset = Omit<AssetEntry, 'source'>;

export interface Analysis {
  passJson: PassJson;
  manifest: TemplateManifest;
  manifestGenerated: boolean;
  styles: PassStyle[];
  version: string;
  /** Bundle files (images, strings) by path, including derived images. */
  files: Map<string, Uint8Array>;
  assets: AnalyzedAsset[];
  /** Image files left out of the bundle because no declared style uses their slot. */
  extras: { name: string; size: number; sha1: string }[];
  tooling: Uint8Array | null;
  report: ValidationReport;
}

export interface AnalyzeOptions {
  /** Uploaded packages get strict names and restricted manifests; baked ones are lenient. */
  uploaded: boolean;
  /** Used when the package has no manifest. */
  fallbackName: string;
  /** Overrides the manifest name (the upload `name` parameter). */
  name?: string;
  images?: ImageTools;
  behaviors?: BehaviorRegistry;
}

function report(issues: ValidationIssue[]): ValidationReport {
  return { ok: !issues.some((i) => i.severity === 'error'), issues };
}

function parseJson(bytes: Uint8Array): unknown {
  return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validates a template package (path -> bytes) and computes everything a version stores. */
export async function analyzePackage(
  input: ReadonlyMap<string, Uint8Array>,
  options: AnalyzeOptions,
): Promise<Analysis | { report: ValidationReport }> {
  const issues: ValidationIssue[] = [];
  const push = (i: ValidationIssue) => issues.push(i);
  const images: ImageFile[] = [];
  const strings = new Map<string, Map<string, string>>();
  const files = new Map<string, Uint8Array>();
  let passBytes: Uint8Array | undefined;
  let manifestBytes: Uint8Array | undefined;
  let tooling: Uint8Array | null = null;

  for (const [path, bytes] of [...input].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const kind = classify(path);
    if (!kind) {
      push({
        severity: options.uploaded ? 'error' : 'warning',
        code: 'NAME_NOT_ALLOWED',
        message: `${path} is not an allowed file name.`,
        path,
      });
      continue;
    }
    if (kind.kind === 'pass') passBytes = bytes;
    else if (kind.kind === 'manifest') manifestBytes = bytes;
    else if (kind.kind === 'tooling') tooling = bytes;
    else if (kind.kind === 'personalization') files.set(path, bytes);
    else if (kind.kind === 'strings') {
      try {
        strings.set(kind.locale, parseStrings(decodeStrings(bytes)));
        files.set(path, bytes);
      } catch (error) {
        push({
          severity: 'error',
          code: 'STRINGS_INVALID',
          message:
            error instanceof Error && error.message ? error.message : 'Invalid strings file.',
          path,
        });
      }
    } else images.push({ path, slot: kind.slot, scale: kind.scale, locale: kind.locale, bytes });
  }

  if (!passBytes) {
    push({ severity: 'error', code: 'PASS_JSON_MISSING', message: 'pass.json is required.' });
    return { report: report(issues) };
  }
  if (passBytes.length > MAX_PASS_JSON_BYTES) {
    push({ severity: 'error', code: 'PASS_JSON_SIZE', message: 'pass.json is larger than 64 KB.' });
    return { report: report(issues) };
  }
  let passJson: PassJson;
  try {
    const parsed = parseJson(passBytes);
    if (!isObject(parsed)) throw new Error('not an object');
    passJson = parsed as PassJson;
  } catch {
    push({
      severity: 'error',
      code: 'PASS_JSON_INVALID',
      message: 'pass.json is not valid JSON.',
      path: 'pass.json',
    });
    return { report: report(issues) };
  }
  for (const key of STRIPPED_KEYS) delete passJson[key];
  const styles = stylesOf(passJson);
  if (styles.length === 0)
    push({
      severity: 'error',
      code: 'NO_STYLE',
      message: 'pass.json needs a style dictionary.',
      path: 'pass.json',
    });

  let manifest: TemplateManifest | undefined;
  let manifestGenerated = false;
  if (manifestBytes) {
    try {
      const parsed = parseJson(manifestBytes);
      if (!isObject(parsed)) throw new Error('not an object');
      manifest = parsed as unknown as TemplateManifest;
    } catch {
      push({
        severity: 'error',
        code: 'MANIFEST_INVALID',
        message: 'wallet.template.json is not valid JSON.',
        path: 'wallet.template.json',
      });
    }
  } else {
    manifest = defaultManifest(passJson, options.fallbackName);
    manifestGenerated = true;
    push({
      severity: 'warning',
      code: 'MANIFEST_GENERATED',
      message: 'No wallet.template.json; generated from field keys.',
    });
  }
  if (manifest && options.name) manifest = { ...manifest, name: options.name };
  if (manifest)
    for (const i of validateManifest(manifest, passJson, {
      uploaded: options.uploaded,
      behaviors: options.behaviors,
    }))
      push(i);

  const tools = options.images ?? {};
  // Preview-only art (web previews) never ships: its size and slot are not the pass's concern.
  const previewOnly = new Set(manifest?.previewOnlyAssets ?? []);
  const quiet = (path: string) => (issue: ValidationIssue) => {
    if (previewOnly.has(path) && issue.severity === 'warning') return;
    push(issue);
  };
  const checked: CheckedImage[] = [];
  for (const image of images) {
    const result = await checkImage(image, tools, quiet(image.path));
    if (result) checked.push(result);
  }
  const derived = await deriveScales(checked, tools, push);
  const all = [...checked, ...derived];

  const used = usedSlots(
    passJson,
    all.some((i) => i.slot === 'artwork'),
  );
  const extras: Analysis['extras'] = [];
  const kept: CheckedImage[] = [];
  for (const image of all) {
    if (used.has(image.slot)) {
      kept.push(image);
      continue;
    }
    quiet(image.path)({
      severity: 'warning',
      code: 'SLOT_UNUSED',
      message: `${image.slot} is not used by ${styles.join(', ') || 'any style'}; left out of the pass.`,
      path: image.path,
    });
    extras.push({ name: image.path, size: image.bytes.length, sha1: await sha1Hex(image.bytes) });
  }

  for (const image of kept)
    for (const issue of pixelIssues(image.path, image.slot, image.bytes))
      push({ severity: 'warning', ...issue, path: image.path });

  if (!kept.some((i) => i.slot === 'icon' && !i.locale))
    push({ severity: 'error', code: 'MISSING_ICON', message: 'icon.png is required.' });

  const locales = [...strings.keys()].sort();
  const reference = locales[0] ? strings.get(locales[0]) : undefined;
  for (const locale of locales.slice(1)) {
    const keys = strings.get(locale) as Map<string, string>;
    const missing = [...(reference?.keys() ?? [])].filter((k) => !keys.has(k));
    const extra = [...keys.keys()].filter((k) => !reference?.has(k));
    if (missing.length || extra.length)
      push({
        severity: 'warning',
        code: 'STRINGS_KEYS',
        message: `${locale}.lproj has different keys than ${locales[0]}.lproj.`,
        path: `${locale}.lproj/pass.strings`,
      });
  }
  const localized = new Map<string, Set<string>>();
  for (const i of kept)
    if (i.locale)
      localized.set(i.locale, (localized.get(i.locale) ?? new Set()).add(`${i.slot}@${i.scale}`));
  const first = [...localized.values()][0];
  for (const [locale, set] of localized)
    if (first && (set.size !== first.size || [...set].some((x) => !first.has(x))))
      push({
        severity: 'warning',
        code: 'LOCALIZED_IMAGES',
        message: `${locale}.lproj has different images than the other locales.`,
        path: `${locale}.lproj`,
      });

  if (!report(issues).ok || !manifest) return { report: report(issues) };

  const assets: AnalyzedAsset[] = [];
  for (const image of kept) {
    files.set(image.path, image.bytes);
    assets.push({
      name: image.path,
      slot: image.slot === 'personalizationLogo' ? 'other' : image.slot,
      scale: image.scale,
      ...(image.locale ? { locale: image.locale } : {}),
      size: image.bytes.length,
      sha1: await sha1Hex(image.bytes),
      crc32: crc32(image.bytes),
      width: image.width,
      height: image.height,
    });
  }
  for (const [path, bytes] of files) {
    if (assets.some((a) => a.name === path)) continue;
    const kind = classify(path);
    assets.push({
      name: path,
      slot: kind?.kind === 'strings' ? 'strings' : 'other',
      scale: 1,
      ...(kind?.kind === 'strings' ? { locale: kind.locale } : {}),
      size: bytes.length,
      sha1: await sha1Hex(bytes),
      crc32: crc32(bytes),
    });
  }
  assets.sort((a, b) => (a.name < b.name ? -1 : 1));
  extras.sort((a, b) => (a.name < b.name ? -1 : 1));
  const version = await contentVersion({ passJson, manifest, assets });
  return {
    passJson,
    manifest,
    manifestGenerated,
    styles,
    version,
    files,
    assets,
    extras,
    tooling,
    report: report(issues),
  };
}
