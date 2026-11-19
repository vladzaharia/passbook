import {
  DENSITY,
  headerCost,
  panelUnits,
  screenUnits,
  titlesOf,
  titleTwoLines,
} from '@/passkit/template/scan-display/density.ts';
import {
  type RenderScanDisplayOptions,
  renderScanDisplay,
} from '@/passkit/template/scan-display/render.ts';
import type { ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import type { ScanDisplayScope } from '@/passkit/template/scan-display/text.ts';
import type { ScanDisplay, ScanDisplayScreen } from '@/shared/contracts/scan-display.ts';

export interface PreviewFit {
  units: number;
  header: number;
  headerParts: { label: string; units: number }[];
  capacity: number;
  panels: { id: string; units: number }[];
}

/** The same density table as validation, with the current role applied. */
export function previewFit(
  display: ScanDisplayDoc,
  screen: ScanDisplayScreen,
  flags = 0,
): PreviewFit {
  if (screen === 'refused')
    return { units: 0, header: 0, headerParts: [], capacity: DENSITY.result, panels: [] };
  const header = headerCost(display, screen, flags);
  const headerParts: PreviewFit['headerParts'] = [];
  if (display.notes?.staff) headerParts.push({ label: 'Staff note', units: DENSITY.header.staff });
  if (screen === 'heads_up') headerParts.push({ label: 'Heads-up', units: DENSITY.header.headsUp });
  if (screen === 'ok') {
    const titles = titlesOf(display);
    if (titles.length)
      headerParts.push({
        label: 'Title',
        units:
          DENSITY.header.title + (titles.some(titleTwoLines) ? DENSITY.header.titleSecondLine : 0),
      });
  }
  if (screen !== 'ready' && display.photo)
    headerParts.push({ label: 'Photo', units: DENSITY.header.photo });
  const remaining = header - headerParts.reduce((sum, part) => sum + part.units, 0);
  if (remaining > 0) headerParts.push({ label: 'Chips', units: remaining });
  return {
    units: screenUnits(display, screen, flags),
    header,
    headerParts,
    capacity: DENSITY.result,
    panels: (display.panels ?? []).map((panel) => ({ id: panel.id, units: panelUnits(panel) })),
  };
}

/** Ask the actual renderer whether a missing row would otherwise render, distinguishing cuts from conditions. */
export function cutRows(
  doc: ScanDisplayDoc,
  scope: ScanDisplayScope,
  options: RenderScanDisplayOptions,
  rendered: ScanDisplay,
): Set<string> {
  const shown = new Set(rendered.panels.flatMap((panel) => panel.rows.map((row) => row.id)));
  const cut = new Set<string>();
  if (options.screen === 'refused') return cut;
  for (const panel of doc.panels ?? [])
    for (const row of panel.rows) {
      if (shown.has(row.id)) continue;
      const alone = renderScanDisplay(
        { ...doc, panels: [{ ...panel, rows: [row] }] },
        scope,
        options,
      );
      if (alone.panels.some((item) => item.rows.some((itemRow) => itemRow.id === row.id)))
        cut.add(row.id);
    }
  return cut;
}
