/**
 * The density budget (DM 1.6, R15). Units are counted at the compact width, worst case, in one
 * table so the screens workstream's fit test can change a constant without touching a rule.
 */
import type { ScanDisplayScreen } from '../../../shared/contracts/scan-display.ts';
import type { ScanDisplayDoc, ScanPanelDoc, ScanRowDoc, ScanText } from './schema.ts';

export const DENSITY = {
  panelRows: 5,
  result: 6,
  frame: 1,
  header: { title: 2, titleSecondLine: 1, headsUp: 2, photo: 1, chips: 1, staff: 1 },
  /** Characters that make a `title` take a second line at the band's headline size. */
  titleOneLine: 14,
  titleCap: 28,
  titleCapBesideName: 20,
  /** `columns` one-line caps at the compact width, by item count. */
  oneLine: { big: { 2: 8, 3: 5, 4: 4 }, normal: { 2: 12, 3: 8, 4: 8 } },
  /** `list.pair` one-line caps. */
  pair: { text: 14, detail: 16 },
  historyDefaultLimit: 3,
} as const;

export type DocScreen = Exclude<ScanDisplayScreen, 'refused'>;
export const DOC_SCREENS: readonly DocScreen[] = ['ready', 'ok', 'heads_up'];

export function oneLineCap(size: 'big' | 'normal', items: number): number {
  const table = DENSITY.oneLine[size] as Record<number, number>;
  return table[items] ?? 0;
}

/** A `columns` row's static worst-case units. */
export function columnsUnits(size: 'big' | 'normal', items: number, oneLine = false): number {
  if (size === 'big') return oneLine || items < 4 ? 2 : 3;
  return oneLine || items < 3 ? 1 : 2;
}

/** A row's worst-case units (everything visible, group rows wrapped). */
export function rowUnits(row: ScanRowDoc): number {
  switch (row.type) {
    case 'heading':
      return 0.5;
    case 'field':
    case 'chips':
    case 'note':
      return 1;
    case 'big':
    case 'money':
    case 'image':
      return 2;
    case 'columns':
      return columnsUnits(row.size ?? 'normal', row.items.length);
    case 'progress':
      return row.style === 'bar' ? 2 : 3;
    case 'history': {
      const limit = row.limit ?? DENSITY.historyDefaultLimit;
      return 0.5 + 0.5 * (limit + (row.source === 'value' ? 1 : 0));
    }
    case 'list':
      return 0.5 * row.items.length;
    case 'divider':
      return 0;
  }
}

export const panelUnits = (panel: ScanPanelDoc): number =>
  panel.rows.reduce((sum, row) => sum + rowUnits(row), 0);

/** The doc's panels that can show on a screen, in document order. */
export const panelsOn = (doc: ScanDisplayDoc, screen: DocScreen): ScanPanelDoc[] =>
  (doc.panels ?? []).filter((panel) => (panel.on ?? DOC_SCREENS).includes(screen));

const textSources = (text: ScanText | null | undefined): string[] =>
  text == null ? [] : typeof text === 'string' ? [text] : [text.one, text.other, text.zero ?? ''];

const NAME_TOKEN = /\{\{\s*holder\.(firstName|name)\s*\}\}/;
export const hasNameToken = (text: ScanText | null | undefined): boolean =>
  textSources(text).some((source) => NAME_TOKEN.test(source));

/** The literal part of a title source: the text outside its bindings. */
export const literalPart = (source: string): string => source.replace(/\{\{[^}]*\}\}/g, '');

export function titlesOf(doc: ScanDisplayDoc): ScanText[] {
  const titles = [doc.header.title, ...(doc.variants ?? []).map((v) => v.header.title)];
  return titles.filter((t): t is ScanText => t !== null && t !== undefined);
}

/** Whether a title can take a second line: a name token, or a literal part over one line. */
export function titleTwoLines(title: ScanText): boolean {
  return (
    hasNameToken(title) ||
    textSources(title).some((s) => Array.from(literalPart(s)).length > DENSITY.titleOneLine)
  );
}

/** The most chips a screen can show before system chips (flags, No photo) join them. */
function chipsPossible(doc: ScanDisplayDoc, systemChips: number): number {
  const base = doc.header.chips ?? [];
  const most = Math.max(
    base.length,
    ...(doc.variants ?? []).map((v) => (v.header.chips ?? base).length),
  );
  return most + systemChips + (doc.photo ? 1 : 0);
}

/** What the header takes of the result's capacity on a screen. `flags` is the manifest's `scan.flags` count. */
export function headerCost(doc: ScanDisplayDoc, screen: DocScreen, flags = 0): number {
  const cost = DENSITY.header;
  let total = 0;
  if (doc.notes?.staff) total += cost.staff;
  if (screen === 'ready') return total;
  if (screen === 'heads_up') total += cost.headsUp;
  if (screen === 'ok') {
    const titles = titlesOf(doc);
    if (titles.length > 0)
      total += cost.title + (titles.some(titleTwoLines) ? cost.titleSecondLine : 0);
  }
  if (doc.photo) total += cost.photo;
  if (chipsPossible(doc, flags) > 2) total += cost.chips;
  return total;
}

/** Worst-case units of the two costliest panels that can show on a screen, frames included. */
export function panelsCost(doc: ScanDisplayDoc, screen: DocScreen): number {
  return panelsOn(doc, screen)
    .map((panel) => DENSITY.frame + panelUnits(panel))
    .sort((a, b) => b - a)
    .slice(0, 2)
    .reduce((sum, units) => sum + units, 0);
}

/** The worst-case total on a screen (header cost plus panels). The editor's fit meter reads this. */
export function screenUnits(doc: ScanDisplayDoc, screen: DocScreen, flags = 0): number {
  return headerCost(doc, screen, flags) + panelsCost(doc, screen);
}

/** C16 `density(doc)`: the `ok` screen's worst case, out of `DENSITY.result`. */
export function density(doc: ScanDisplayDoc, screen: DocScreen = 'ok', flags = 0): number {
  return screenUnits(doc, screen, flags);
}
