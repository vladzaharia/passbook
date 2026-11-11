import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';

/** The outline id an issue's path points at; 'header' when it names no part. */
export function scanIssueTarget(display: ScanDisplayDoc, path: string | undefined): string {
  const parts = (path ?? '').replace(/^scan\.display\.?/, '').split('.');
  if (parts[0] === 'panels') {
    const panel = display.panels?.[Number(parts[1])];
    if (!panel) return 'panels';
    const row = parts[2] === 'rows' ? panel.rows[Number(parts[3])] : undefined;
    if (
      row &&
      parts[4] === 'items' &&
      (row.type === 'columns' || row.type === 'chips' || row.type === 'list')
    )
      return row.items[Number(parts[5])]?.id ?? row.id;
    return row?.id ?? panel.id;
  }
  if (parts[0] === 'variants') {
    const variant = display.variants?.[Number(parts[1])];
    if (!variant) return 'rules';
    return parts[2] === 'header' && parts[3] === 'chips'
      ? (variant.header.chips?.[Number(parts[4])]?.id ?? variant.id)
      : variant.id;
  }
  if (parts[0] === 'header' && parts[1] === 'chips')
    return display.header.chips?.[Number(parts[2])]?.id ?? 'header';
  if (parts[0] === 'notes') return 'notes';
  return 'header';
}
