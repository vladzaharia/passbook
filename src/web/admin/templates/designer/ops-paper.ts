import type { PaperBarcode, PaperSize } from '@/passkit/template/paper.ts';
import type { DesignDoc } from './model.ts';
import { copy } from './ops-pass.ts';

/** One edit of the manifest's `paper` block. `null` drops the block: the layout is derived again. */
export type PaperPatch = null | {
  size?: PaperSize;
  barcode?: PaperBarcode;
  fields?: string[];
  terms?: string;
  holder?: boolean;
};

/**
 * Writes the block with the same shape paper.ts validates: schema 1, size and barcode always, and
 * `fields`, `terms` and `holder: false` only when set. A patch on a derived layout starts from the
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
  const fields = patch.fields ?? old.fields;
  if (Array.isArray(fields) && fields.length > 0) block.fields = fields;
  const terms = 'terms' in patch ? patch.terms : old.terms;
  if (typeof terms === 'string' ? terms.trim() : terms) block.terms = terms;
  const holder = 'holder' in patch ? patch.holder : old.holder;
  if (holder === false) block.holder = false;
  next.manifest.paper = block;
  return next;
}
