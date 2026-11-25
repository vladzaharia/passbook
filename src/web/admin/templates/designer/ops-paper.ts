import {
  type PaperBarcode,
  type PaperInk,
  type PaperKind,
  type PaperSheet,
  type PaperSize,
  sheetApplies,
} from '@/passkit/template/paper.ts';
import type { DesignDoc } from './model.ts';
import { copy } from './ops-pass.ts';

/** One edit of the manifest's `paper` block. `null` drops the block: the layout is derived again. */
export type PaperPatch = null | {
  size?: PaperSize;
  /** Card sizes: print both faces on a home sheet. `null` prints the card at its own size. */
  sheet?: PaperSheet | null;
  barcode?: PaperBarcode;
  fields?: string[];
  terms?: string;
  holder?: boolean | undefined;
  /** `null` goes back to the layout derived from the template. */
  kind?: PaperKind | null;
  ink?: PaperInk;
  fold?: boolean;
  /** Extra "Bring" lines, one per line. */
  bring?: string;
  buddy?: boolean;
};

/**
 * Writes the block with the same shape paper.ts validates: schema 1, size and barcode always, and
 * the rest (`fields`, `terms`, `holder: false`, `kind`, `ink: mono`, `fold: false`, `bring`, `buddy: true`)
 * only when set. A patch on a derived layout starts from the
 * defaults (A4, QR).
 */
export function setPaper(doc: DesignDoc, patch: PaperPatch): DesignDoc {
  const next = copy(doc);
  if (patch === null) {
    delete next.manifest.paper;
    return next;
  }
  const old =
    next.manifest.paper && typeof next.manifest.paper === 'object'
      ? (next.manifest.paper as Record<string, unknown>)
      : {};
  const block: Record<string, unknown> = {
    schema: 1,
    size: patch.size ?? old.size ?? 'a4',
    barcode: patch.barcode ?? old.barcode ?? 'qr',
  };
  // Only a card or strip takes a sheet; a size change never carries one the schema would warn on.
  const sheet = 'sheet' in patch ? patch.sheet : old.sheet;
  if ((sheet === 'a4' || sheet === 'letter') && sheetApplies(block.size as PaperSize))
    block.sheet = sheet;
  const fields = patch.fields ?? old.fields;
  if (Array.isArray(fields) && fields.length > 0) block.fields = fields;
  const terms = 'terms' in patch ? patch.terms : old.terms;
  if (typeof terms === 'string' ? terms.trim() : terms) block.terms = terms;
  const holder = 'holder' in patch ? patch.holder : old.holder;
  if (typeof holder === 'boolean') block.holder = holder;
  const kind = 'kind' in patch ? patch.kind : old.kind;
  if (typeof kind === 'string') block.kind = kind;
  const ink = patch.ink ?? old.ink;
  if (ink === 'mono') block.ink = ink;
  const fold = 'fold' in patch ? patch.fold : old.fold;
  if (fold === false) block.fold = false;
  const bring = 'bring' in patch ? patch.bring : old.bring;
  if (typeof bring === 'string' && bring.trim()) block.bring = bring;
  const buddy = 'buddy' in patch ? patch.buddy : old.buddy;
  if (buddy === true) block.buddy = true;
  next.manifest.paper = block;
  return next;
}
