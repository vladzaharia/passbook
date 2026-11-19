import type { ScanDisplay } from '@/shared/contracts/scan-display.ts';

/** One thing in the scanner's screen the designer can select or explain. */
export interface PreviewTarget {
  id: string;
  /** Roving-focus key: two targets can select the same id (a header part). */
  focusKey: string;
  label: string;
  locked: boolean;
  els: Element[];
}

const all = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll(selector));
const LOCKED_VERDICT = 'System. The verdict and its meaning cannot be changed.';

/**
 * Finds the parts of the scanner's painted screen by the scanner's own class names and maps them
 * to the display document's ids by order. The scanner paints nothing for the designer: the targets
 * are read off the result, so the screen is the scanner's whatever the overlay does.
 */
export function collectTargets(doc: Document, rendered: ScanDisplay): PreviewTarget[] {
  const out: PreviewTarget[] = [];
  const add = (
    id: string,
    label: string,
    els: Element[],
    locked = false,
    focusKey: string = id,
  ) => {
    if (els.length) out.push({ id, focusKey, label, locked, els });
  };
  const ready = rendered.screen === 'ready';
  const band = all(doc, '.scan-result-band');
  add(
    'system-verdict',
    ready ? 'System. The ready heading cannot be changed.' : LOCKED_VERDICT,
    ready ? all(doc, '.scan-ready-heading') : band,
    true,
  );
  add('header', 'Header, custom icon', all(doc, '.scan-custom-glyph'), false, 'header-icon');
  if (band.some((el) => el.getAttribute('data-layout') === 'custom'))
    add('header', 'Header, custom title', all(doc, '.scan-verdict-text h1'), false, 'header-title');
  add(
    'system-identity',
    'System. The holder line always shows; choose its source in Header.',
    all(doc, '.scan-identity-photo, .scan-pass-tile, .scan-result-holder'),
    true,
  );
  add('header', 'Header, meta line', all(doc, '.scan-identity-meta'), false, 'header-meta');
  all(doc, '.scan-identity-chips .scan-identity-chip').forEach((el, i) => {
    const chip = rendered.header.chips[i];
    if (chip) add(chip.id, `Chip ${chip.text}`, [el]);
  });
  const panels = all(doc, '.sd-panel');
  if (panels.length === rendered.panels.length)
    panels.forEach((el, i) => {
      const panel = rendered.panels[i];
      if (!panel) return;
      const n = panel.rows.length;
      add(
        panel.id,
        `Panel ${panel.title ?? 'Untitled'}, ${n} ${n === 1 ? 'row' : 'rows'}`,
        all(el, ':scope > .sd-panel-head'),
      );
      const rows = all(el, ':scope > .sd-rows > *');
      if (rows.length !== n) return;
      rows.forEach((row, j) => {
        const item = panel.rows[j];
        if (!item) return;
        if (item.type !== 'chips') {
          add(item.id, `Row ${item.type}`, [row]);
          return;
        }
        add(item.id, 'Row, chips', [row]);
        all(row, '.sd-chip').forEach((chipEl, k) => {
          const chip = item.items[k];
          if (chip) add(chip.id, `Chip ${chip.text}`, [chipEl]);
        });
      });
    });
  const note = rendered.screen === 'refused' ? rendered.notes.refused : rendered.notes.staff;
  if (note)
    add(
      'notes',
      rendered.screen === 'refused' ? 'Refused note' : 'Staff note',
      all(doc, '.scan-result-notes'),
    );
  add(
    'system-actions',
    'System. Actions are configured separately from the scan display.',
    all(doc, '.scan-dock-row'),
    true,
  );
  return out;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The union of the elements' boxes, in the frame's own pixels. Hidden elements have none. */
export function boxOf(els: Element[]): Box | null {
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return left === Infinity ? null : { x: left, y: top, w: right - left, h: bottom - top };
}
