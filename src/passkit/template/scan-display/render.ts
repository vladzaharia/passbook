/**
 * `renderScanDisplay` (C16, DM 5.1): the doc and a role-filtered scope to a `ScanDisplay`.
 * Pure, no clock, no worker. The bundle check looks for the literal in the error below.
 */
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import type { ScanRole } from '../../types.ts';
import { testCond } from './condition.ts';
import { DENSITY } from './density.ts';
import { sanitized } from './format.ts';
import { migrateScanDisplay } from './migrate.ts';
import { bandTitle, docCurrency, holderNames } from './render-header.ts';
import { type RowCtx, renderChips, renderedUnits, renderRow, shown } from './render-rows.ts';
import type { ScanDisplayDoc, ScanPanelDoc } from './schema.ts';
import { roleAtLeast } from './scope.ts';
import { evalString, evalText, type ScanDisplayScope } from './text.ts';

export interface RenderScanDisplayOptions {
  screen: ScanDisplay['screen'];
  role: ScanRole;
  /** A till: no panels. */
  terminal?: boolean;
  locale: string;
  timeZone: string;
  now: number;
  actionId?: string;
  /** An amount control is open: one panel only. */
  amountOpen?: boolean;
}

type Panel = ScanDisplay['panels'][number];

/** Elements above the role are removed before anything is evaluated (DM 5.2). */
export function filterDoc(doc: ScanDisplayDoc, role: ScanRole, terminal = false): ScanDisplayDoc {
  const ok = (el: { minRole?: ScanRole | undefined }) => roleAtLeast(role, el.minRole);
  const header = (h: ScanDisplayDoc['header']) =>
    h.chips ? { ...h, chips: h.chips.filter(ok) } : h;
  const out: ScanDisplayDoc = { ...doc, header: header(doc.header) };
  if (doc.variants) out.variants = doc.variants.map((v) => ({ ...v, header: header(v.header) }));
  if (doc.photo && !ok(doc.photo)) delete out.photo;
  out.panels = terminal
    ? []
    : (doc.panels ?? []).filter(ok).map((panel) => ({
        ...panel,
        rows: panel.rows.filter(ok).map((row) => {
          if (row.type === 'chips') return { ...row, items: row.items.filter(ok) };
          if (row.type === 'list') return { ...row, items: row.items.filter(ok) };
          return row;
        }),
      }));
  return out;
}

const units = (panel: Panel) => panel.rows.reduce((sum, row) => sum + renderedUnits(row), 0);

/** Drops trailing rows, then trailing panels, until the screen fits. Never the first row (DM 1.6). */
function cutToFit(panels: Panel[], capacity: number): Panel[] {
  const out = panels.map((p) => ({ ...p, rows: [...p.rows] }));
  const total = () => out.reduce((sum, p) => sum + DENSITY.frame + units(p), 0);
  for (const panel of out)
    while (panel.rows.length > 1 && units(panel) > DENSITY.panelRows) panel.rows.pop();
  while (total() > capacity) {
    const last = out[out.length - 1];
    if (!last) break;
    if (last.rows.length > 1) last.rows.pop();
    else if (out.length > 1) out.pop();
    else break;
  }
  for (const panel of out)
    while (panel.rows.length > 1 && ['heading', 'divider'].includes(panel.rows.at(-1)?.type ?? ''))
      panel.rows.pop();
  return out;
}

function renderPanel(panel: ScanPanelDoc, rc: RowCtx): Panel | null {
  const rows = panel.rows.map((row) => renderRow(row, rc)).filter((row) => row !== null);
  if (rows.length === 0) return null;
  return {
    id: panel.id,
    kind: panel.preset?.id ?? 'custom',
    title: sanitized(evalText(panel.title, rc), 24) || null,
    icon: panel.icon ?? null,
    tone: panel.tone ?? null,
    rows,
  };
}

export function renderScanDisplay(
  input: ScanDisplayDoc,
  scope: ScanDisplayScope,
  options: RenderScanDisplayOptions,
): ScanDisplay {
  const doc = filterDoc(migrateScanDisplay(input), options.role, options.terminal);
  const { screen } = options;
  if (!['ready', 'ok', 'heads_up', 'refused'].includes(screen))
    throw new Error(`scan-display:render: unknown screen ${String(screen)}`);
  const base: ScanDisplayScope = { ...scope, now: options.now };
  const pass = base.pass as Record<string, unknown> | undefined;
  if (pass && !roleAtLeast(options.role, 'desk'))
    base.pass = { ...pass, externalId: null } as never;
  const plainCtx = {
    scope: base,
    locale: options.locale,
    timeZone: options.timeZone,
    now: options.now,
  };

  const names = holderNames(doc.holder ? evalString(doc.holder, plainCtx) : '', plainCtx);
  const ctx = {
    ...plainCtx,
    scope: {
      ...base,
      holder: { name: names.name, firstName: names.firstName, initials: names.initials },
    },
  };
  const currency = docCurrency(doc.currency, ctx);
  const rc: RowCtx = { ...ctx, currency, docCurrency: currency };

  const assets = base.assets as Record<string, unknown> | undefined;
  const photoUrl = typeof assets?.photo === 'string' ? assets.photo : null;
  const identity = {
    holder: names.name,
    initials: names.initials,
    photo:
      doc.photo && screen !== 'refused' ? { url: photoUrl, alt: `Photo of ${names.name}` } : null,
  };
  const out: ScanDisplay = {
    v: 1,
    screen,
    templateVersion: typeof base.templateVersion === 'string' ? base.templateVersion : '',
    variant: null,
    identity,
    header: { icon: null, title: null, titleLines: 1, meta: null, chips: [] },
    panels: [],
    notes: { staff: null, refused: null },
  };
  if (screen === 'refused') {
    out.notes.refused = doc.notes?.refused ? sanitized(doc.notes.refused, 100) || null : null;
    return out;
  }

  const variant = (doc.variants ?? []).find((v) => testCond(v.when, rc));
  out.variant = variant?.id ?? null;
  const slot = <K extends 'icon' | 'title' | 'subtitle' | 'chips'>(key: K) =>
    variant && variant.header[key] !== undefined ? variant.header[key] : doc.header[key];
  const scan = base.scan as Record<string, unknown> | undefined;
  const custom = screen === 'ok' && scan?.direction !== 'out';
  if (custom) out.header.icon = slot('icon') ?? null;
  const title = custom ? bandTitle(slot('title'), rc, names) : { text: null, lines: 1 as const };
  out.header.title = title.text;
  out.header.titleLines = title.lines;
  out.header.meta = sanitized(evalText(slot('subtitle'), rc), 60) || null;
  out.header.chips = renderChips(slot('chips') ?? [], rc).slice(0, 2);
  out.notes.staff = sanitized(evalText(doc.notes?.staff, rc), 140, true) || null;

  const panels = (doc.panels ?? [])
    .filter((panel) => (panel.on ?? ['ready', 'ok', 'heads_up']).includes(screen))
    .filter(
      (panel) => !panel.actions || !options.actionId || panel.actions.includes(options.actionId),
    )
    .filter((panel) => shown(panel, rc))
    .map((panel) => renderPanel(panel, rc))
    .filter((panel) => panel !== null)
    .slice(0, options.amountOpen ? 1 : 2);

  const cost = DENSITY.header;
  let capacity = DENSITY.result;
  if (out.notes.staff) capacity -= cost.staff;
  if (screen === 'heads_up') capacity -= cost.headsUp;
  if (screen === 'ok' && out.header.title)
    capacity -= cost.title + (title.lines === 2 ? cost.titleSecondLine : 0);
  if (screen !== 'ready' && identity.photo) capacity -= cost.photo;
  const noPhotoChip = identity.photo && !identity.photo.url ? 1 : 0;
  if (screen !== 'ready' && out.header.chips.length + noPhotoChip > 2) capacity -= cost.chips;
  out.panels = cutToFit(panels, capacity);
  return out;
}
