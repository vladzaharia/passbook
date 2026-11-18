/** The non-field parts of the view: barcodes, colours, images, relevance, links and events. */
import type { ShippedAsset } from '../build-assets.ts';
import { parseColor } from '../schema/image-pixels.ts';
import { classifyAsset } from '../template/package.ts';
import type { WalletsManifest } from '../template/wallets/schema.ts';
import type { AssetEntry, PassJson } from '../types.ts';
import {
  BARCODE_KINDS,
  type BarcodeKind,
  type ViewBarcode,
  type ViewEvent,
  type ViewImageFile,
  type ViewImages,
  type ViewNote,
  type ViewRelevance,
  WALLET_TARGETS,
  type WalletTarget,
} from './types.ts';

export function barcodeKind(format: string): BarcodeKind | 'other' {
  const name = format.replace(/^PKBarcodeFormat/u, '').toLowerCase();
  return (BARCODE_KINDS as readonly string[]).includes(name) ? (name as BarcodeKind) : 'other';
}

/** `barcodes` in Apple's fallback order; the deprecated `barcode` when it is all there is. */
export function barcodesOf(pass: PassJson): ViewBarcode[] {
  const list = pass.barcodes ?? (pass.barcode ? [pass.barcode] : []);
  return list.map((b) => ({
    format: b.format,
    kind: barcodeKind(b.format),
    message: b.message,
    encoding: b.messageEncoding,
    ...(b.altText ? { altText: b.altText } : {}),
  }));
}

export function colorsOf(pass: PassJson) {
  const hex = (value: unknown): string | undefined => {
    const rgb = parseColor(value);
    return rgb
      ? `#${rgb.map((c) => Math.min(255, c).toString(16).padStart(2, '0')).join('')}`
      : undefined;
  };
  const pick = <K extends string>(key: K, value: unknown) => {
    const found = hex(value);
    return found ? ({ [key]: found } as Record<K, string>) : {};
  };
  return {
    ...pick('background', pass.backgroundColor),
    ...pick('foreground', pass.foregroundColor),
    ...pick('label', pass.labelColor),
    ...pick('footerBackground', pass.footerBackgroundColor),
  };
}

export function relevanceOf(pass: PassJson): ViewRelevance {
  const dates = (pass.relevantDates ?? []).map((d) => {
    const start = d.startDate ?? d.date ?? d.relevantDate;
    return { ...(start ? { start } : {}), ...(d.endDate ? { end: d.endDate } : {}) };
  });
  if (dates.length === 0 && pass.relevantDate) dates.push({ start: pass.relevantDate });
  return {
    dates,
    locations: pass.locations ?? [],
    beacons: pass.beacons ?? [],
    ...(typeof pass.maxDistance === 'number' ? { maxDistance: pass.maxDistance } : {}),
  };
}

const EXCLUDED_URLS = new Set(['webServiceURL', 'appLaunchURL']);

/** Event guide and service URLs at the top of pass.json, by key. */
export function urlsOf(pass: PassJson): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of Object.keys(pass).sort()) {
    const value = pass[key];
    if (
      typeof value === 'string' &&
      !EXCLUDED_URLS.has(key) &&
      /^(?:contactVenue|transitProvider|.*URL$)/u.test(key)
    )
      out[key] = value;
  }
  return out;
}

export function eventsOf(pass: PassJson): ViewEvent[] {
  return (pass.upcomingPassInformation ?? []).map((e) => ({
    identifier: e.identifier,
    name: e.name,
    ...(e.dateInformation?.date ? { date: e.dateInformation.date } : {}),
    active: e.isActive === true,
  }));
}

export interface ImageContext {
  assets?: readonly AssetEntry[];
  assetUrl?: (name: string) => string | undefined;
}

/** Apple art by slot, best scale first; `wallets/<target>/` art by its manifest slot. */
export function imagesOf(
  shipped: readonly ShippedAsset[],
  wallets: WalletsManifest | undefined,
  ctx: ImageContext,
  notes: ViewNote[],
): ViewImages {
  const apple: Record<string, ViewImageFile[]> = {};
  for (const asset of shipped) {
    const kind = classifyAsset(asset.name);
    if (!kind || kind.slot === 'strings' || kind.slot === 'other' || kind.slot === 'source')
      continue;
    const personal = asset.bytes !== undefined;
    const url = personal ? undefined : ctx.assetUrl?.(asset.name);
    const list = apple[kind.slot] ?? [];
    apple[kind.slot] = list;
    list.push({
      name: asset.name,
      slot: kind.slot,
      scale: kind.scale,
      ...(kind.locale ? { locale: kind.locale } : {}),
      ...(asset.width ? { width: asset.width } : {}),
      ...(asset.height ? { height: asset.height } : {}),
      personal,
      ...(url ? { url } : {}),
    });
  }
  for (const files of Object.values(apple))
    files.sort(
      (a, b) =>
        b.scale - a.scale ||
        (a.locale ?? '').localeCompare(b.locale ?? '') ||
        (a.name < b.name ? -1 : 1),
    );
  const overrides: ViewImages['overrides'] = {};
  for (const target of WALLET_TARGETS) {
    const bySlot = walletArt(target, wallets, ctx, notes);
    if (bySlot) overrides[target] = bySlot;
  }
  return { apple, overrides };
}

function walletArt(
  target: WalletTarget,
  wallets: WalletsManifest | undefined,
  ctx: ImageContext,
  notes: ViewNote[],
): Record<string, ViewImageFile> | undefined {
  const images = (wallets?.[target]?.images ?? {}) as Record<string, string>;
  const out: Record<string, ViewImageFile> = {};
  for (const slot of Object.keys(images).sort()) {
    const name = images[slot] as string;
    const entry = ctx.assets?.find((a) => a.name === name);
    if (!entry) {
      notes.push({
        code: 'ART_MISSING',
        subject: name,
        message: `No file ${name} in the template.`,
      });
      continue;
    }
    const url = ctx.assetUrl?.(name);
    out[slot] = {
      name,
      slot,
      scale: 1,
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
      personal: false,
      ...(url ? { url } : {}),
    };
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
