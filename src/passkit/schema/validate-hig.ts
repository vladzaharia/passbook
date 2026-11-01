import { PASS_STYLES } from '../types.ts';
import { FIELD_GROUPS } from './constants.ts';
import { isObject, type ValidationContext } from './util.ts';
import type { ValidatableAsset } from './validate-images.ts';

type Field = Record<string, unknown>;

/** Every field of every style dictionary with its group and path. */
function eachField(ctx: ValidationContext): { field: Field; group: string; path: string }[] {
  const out: { field: Field; group: string; path: string }[] = [];
  for (const style of PASS_STYLES) {
    const dict = ctx.pass[style];
    if (!isObject(dict)) continue;
    for (const group of FIELD_GROUPS) {
      const list = dict[group];
      if (!Array.isArray(list)) continue;
      list.forEach((field, i) => {
        if (isObject(field)) out.push({ field, group, path: `${style}.${group}[${i}]` });
      });
    }
  }
  return out;
}

const RGB = /^rgb\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*\)$/;
function luminance(value: unknown): number | undefined {
  const m = typeof value === 'string' ? RGB.exec(value) : null;
  if (!m) return undefined;
  const lin = (c: number) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  const [r, g, b] = [m[1], m[2], m[3]].map((n) => lin(Number(n))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: number, b: number) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/** Foreground 4.5:1 and labels 3:1 on the background; image-backed passes get a reminder. */
function checkContrast(ctx: ValidationContext, assets: ValidatableAsset[]): void {
  const bg = luminance(ctx.pass.backgroundColor);
  const fg = luminance(ctx.pass.foregroundColor);
  const label = luminance(ctx.pass.labelColor);
  if (bg !== undefined && fg !== undefined && ratio(bg, fg) < 4.5)
    ctx.warn(
      'COLOR_CONTRAST',
      `Text contrast is ${ratio(bg, fg).toFixed(1)}:1; use at least 4.5:1.`,
      'foregroundColor',
    );
  if (bg !== undefined && label !== undefined && ratio(bg, label) < 3)
    ctx.warn(
      'COLOR_CONTRAST',
      `Label contrast is ${ratio(bg, label).toFixed(1)}:1; use at least 3:1.`,
      'labelColor',
    );
  if (assets.some((a) => /^(?:[^/]+\.lproj\/)?(background|artwork)(@[23]x)?\.png$/.test(a.name)))
    (ctx.info ?? ctx.warn)(
      'COLOR_CONTRAST',
      'Text sits on an image: check that every field reads.',
      'backgroundColor',
    );
}

/** Characters Wallet fits on one line, per row. Formatted values (dates, numbers) are skipped. */
const FRONT_LIMITS: Record<string, number> = {
  headerFields: 12,
  primaryFields: 20,
  secondaryFields: 22,
  auxiliaryFields: 22,
};
const FORMATTED = ['dateStyle', 'timeStyle', 'numberStyle', 'currencyCode'];

function checkLengths(ctx: ValidationContext): void {
  for (const { field, group, path } of eachField(ctx)) {
    const limit = FRONT_LIMITS[group];
    if (!limit || FORMATTED.some((k) => k in field) || typeof field.value !== 'string') continue;
    if (field.value.length > limit)
      ctx.warn(
        'FIELD_LENGTH',
        `${String(field.label ?? field.key)} has ${field.value.length} characters; about ${limit} fit.`,
        `${path}.value`,
      );
  }
}

const PLACEHOLDER_HOST = /(^|\.)(example\.(com|org|net)|localhost)$|\.(test|localhost)$/i;
const SERVER_KEYS = new Set(['webServiceURL', 'authenticationToken']);

/** example.com, localhost and test TLDs in any link the holder can open. */
function checkPlaceholderUrls(ctx: ValidationContext): void {
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https?:\/\/([^/\s"'<>:]+)/gi))
        if (match[1] && PLACEHOLDER_HOST.test(match[1]))
          ctx.warn('PLACEHOLDER_URL', `${match[1]} is a placeholder address.`, path);
    } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`));
    else if (isObject(value))
      for (const [k, v] of Object.entries(value))
        if (!SERVER_KEYS.has(k)) walk(v, path ? `${path}.${k}` : k);
  };
  walk(ctx.pass, '');
}

const CONTACT = /(https?:\/\/|mailto:|tel:|@[\w-]+\.\w|\+?\d[\d\s().-]{6,}\d)/i;

function checkBackContact(ctx: ValidationContext): void {
  const back = eachField(ctx).filter((f) => f.group === 'backFields');
  const reachable = back.some(({ field }) =>
    [field.value, field.attributedValue].some((v) => typeof v === 'string' && CONTACT.test(v)),
  );
  if (!reachable)
    ctx.warn('BACK_CONTACT', 'Add a phone, email or link on the back so holders can get help.');
}

const FREE_TEXT = /note|message|terms|details|description|about|info/i;

function checkChangeMessages(ctx: ValidationContext): void {
  for (const { field, path } of eachField(ctx)) {
    if (typeof field.changeMessage !== 'string' || !field.changeMessage.includes('%@')) continue;
    const name = `${String(field.key ?? '')} ${String(field.label ?? '')}`;
    const long = typeof field.value === 'string' && field.value.length > 40;
    if (FREE_TEXT.test(name) || long)
      ctx.warn(
        'CHANGE_MESSAGE_FREE_TEXT',
        'A change message on free text repeats the whole text on the lock screen.',
        `${path}.changeMessage`,
      );
  }
}

function checkPlatformName(ctx: ValidationContext): void {
  for (const key of ['logoText', 'eventLogoText', 'description'] as const) {
    const value = ctx.pass[key];
    if (typeof value === 'string' && /\bwallet\b/i.test(value))
      ctx.warn('LOGO_TEXT_PLATFORM', `${key} names the platform; use the organization.`, key);
  }
}

const KB = 1024;
function checkSizes(ctx: ValidationContext, assets: ValidatableAsset[]): void {
  let total = new TextEncoder().encode(JSON.stringify(ctx.pass)).length;
  for (const a of assets) {
    if (a.size === undefined) continue;
    total += a.size;
    if (/\.png$/.test(a.name) && a.size > 200 * KB)
      ctx.warn(
        'IMAGE_BYTES',
        `${a.name} is ${Math.round(a.size / KB)} KB; keep images under 200 KB.`,
        a.name,
      );
  }
  if (assets.some((a) => a.size !== undefined) && total > 400 * KB)
    ctx.warn('PASS_SIZE', `The pass is ${Math.round(total / KB)} KB; keep it under 400 KB.`);
}

const PLACE_KEYS = /venue|airport|departure|arrival|location/i;
function checkLocalTime(ctx: ValidationContext): void {
  const semantics = isObject(ctx.pass.semantics) ? Object.keys(ctx.pass.semantics) : [];
  const located =
    (Array.isArray(ctx.pass.locations) && ctx.pass.locations.length > 0) ||
    semantics.some((k) => PLACE_KEYS.test(k));
  if (!located) return;
  for (const { field, path } of eachField(ctx)) {
    const dated = 'dateStyle' in field || 'timeStyle' in field;
    if (
      dated &&
      typeof field.value === 'string' &&
      /Z$/.test(field.value) &&
      !field.ignoresTimeZone
    )
      ctx.warn(
        'LOCAL_TIME',
        'This time is in UTC; use the local offset and ignoresTimeZone so it reads in local time.',
        `${path}.value`,
      );
  }
}

const LINEAR = new Set([
  'PKBarcodeFormatCode128',
  'PKBarcodeFormatCode39',
  'PKBarcodeFormatCodabar',
  'PKBarcodeFormatEAN13',
  'PKBarcodeFormatI2of5',
]);
function checkPosterBarcode(ctx: ValidationContext): void {
  if (!ctx.styles.has('PET') && !ctx.styles.has('posterGeneric')) return;
  const codes = Array.isArray(ctx.pass.barcodes) ? ctx.pass.barcodes : [];
  if (codes.some((b) => isObject(b) && LINEAR.has(String(b.format))))
    (ctx.info ?? ctx.warn)(
      'POSTER_LINEAR_BARCODE',
      'Poster passes show a linear barcode small; a QR or Aztec code scans faster.',
      'barcodes',
    );
}

/** Codes this file reports; structural fixtures that predate the lint filter them out. */
export const HIG_CODES: ReadonlySet<string> = new Set([
  'COLOR_CONTRAST',
  'FIELD_LENGTH',
  'PLACEHOLDER_URL',
  'BACK_CONTACT',
  'CHANGE_MESSAGE_FREE_TEXT',
  'LOGO_TEXT_PLATFORM',
  'PASS_SIZE',
  'IMAGE_BYTES',
  'LOCAL_TIME',
  'POSTER_LINEAR_BARCODE',
]);

/** Human Interface Guidelines checks: warnings, plus info for advice that needs no action. */
export function validateHig(ctx: ValidationContext, assets: ValidatableAsset[]): void {
  checkContrast(ctx, assets);
  checkLengths(ctx);
  checkPlaceholderUrls(ctx);
  checkBackContact(ctx);
  checkChangeMessages(ctx);
  checkPlatformName(ctx);
  checkSizes(ctx, assets);
  checkLocalTime(ctx);
  checkPosterBarcode(ctx);
}
