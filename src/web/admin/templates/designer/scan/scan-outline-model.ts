import type { ScanDisplayDoc, ScanRowDoc } from '@/passkit/template/scan-display/schema.ts';
import { allIds, copyPanel, copyRow, nextId } from './scan-outline-ids.ts';
import { placementReason, reorder, replacePanel, withoutRefs } from './scan-outline-utils.ts';

export * from './scan-outline-utils.ts';

export type ScanSelectionAction = 'up' | 'down' | 'duplicate' | 'remove';
export type ScanSelectionResult =
  | { kind: 'change'; display: ScanDisplayDoc; selected: string | null; message: string }
  | { kind: 'confirm'; panelId: string; message: string }
  | { kind: 'blocked'; message: string };

const blocked = (message: string): ScanSelectionResult => ({ kind: 'blocked', message });
const changed = (
  display: ScanDisplayDoc,
  selected: string | null,
  message: string,
): ScanSelectionResult => ({ kind: 'change', display, selected, message });
const indexAfterMove = (index: number, length: number, action: ScanSelectionAction) => {
  const to = index + (action === 'up' ? -1 : 1);
  return to >= 0 && to < length ? to : null;
};

/** The same immutable selection operations serve outline buttons and canvas shortcuts. */
export function scanSelectionAction(
  display: ScanDisplayDoc,
  id: string,
  action: ScanSelectionAction,
  confirmed = false,
): ScanSelectionResult {
  const panels = display.panels ?? [];
  const panelIndex = panels.findIndex((item) => item.id === id);
  if (panelIndex >= 0) {
    const panel = panels[panelIndex];
    if (!panel) return blocked('Panel not found.');
    if (action === 'remove') {
      if (!confirmed)
        return { kind: 'confirm', panelId: panel.id, message: 'Remove this panel and its rows?' };
      return changed(
        withoutRefs({ ...display, panels: panels.filter((item) => item.id !== id) }, [], id),
        null,
        'Panel removed. Undo to restore it.',
      );
    }
    if (action === 'duplicate') {
      if (panels.length >= 6) return blocked('A scan screen holds six panels.');
      const copy = copyPanel(panel, allIds(display));
      const next = [...panels];
      next.splice(panelIndex + 1, 0, copy);
      const updated = { ...display, panels: next };
      const reason = placementReason(display, updated);
      return reason ? blocked(reason) : changed(updated, copy.id, 'Panel duplicated.');
    }
    const to = indexAfterMove(panelIndex, panels.length, action);
    if (to === null) return blocked('The panel is already at the edge.');
    return changed(
      { ...display, panels: reorder(panels, panelIndex, to) },
      id,
      `Panel moved to position ${to + 1} of ${panels.length}.`,
    );
  }

  for (const panel of panels) {
    const index = panel.rows.findIndex((row) => row.id === id);
    if (index >= 0) {
      const row = panel.rows[index];
      if (!row) return blocked('Row not found.');
      let rows: ScanRowDoc[];
      let selected: string | null = id;
      let message: string;
      if (action === 'remove') {
        rows = panel.rows.filter((item) => item.id !== id);
        selected = panel.id;
        message = 'Row removed. Undo to restore it.';
      } else if (action === 'duplicate') {
        if (panel.rows.length >= 6) return blocked('A panel holds six rows.');
        const copy = copyRow(row, allIds(display));
        rows = [...panel.rows];
        rows.splice(index + 1, 0, copy);
        selected = copy.id;
        message = 'Row duplicated.';
      } else {
        const to = indexAfterMove(index, panel.rows.length, action);
        if (to === null) return blocked('The row is already at the edge.');
        rows = reorder(panel.rows, index, to);
        message = `Row moved to position ${to + 1} of ${panel.rows.length}.`;
      }
      const updated = replacePanel(display, { ...panel, rows });
      const reason = placementReason(display, updated);
      return reason ? blocked(reason) : changed(updated, selected, message);
    }
    for (const row of panel.rows) {
      if (row.type !== 'columns' && row.type !== 'chips' && row.type !== 'list') continue;
      const itemIndex = row.items.findIndex((item) => item.id === id);
      if (itemIndex < 0) continue;
      const item = row.items[itemIndex];
      if (!item) return blocked('Item not found.');
      const items = [...row.items];
      let selected: string | null = id;
      let message: string;
      if (action === 'remove') {
        const min = row.type === 'columns' ? 2 : 1;
        if (items.length <= min)
          return blocked(`This row needs at least ${min} ${min === 1 ? 'item' : 'items'}.`);
        items.splice(itemIndex, 1);
        selected = row.id;
        message = 'Item removed. Undo to restore it.';
      } else if (action === 'duplicate') {
        if (items.length >= 4) return blocked('This row holds four items.');
        const copy = { ...item, id: nextId(allIds(display), row.type === 'chips' ? 'c_' : 'i_') };
        items.splice(itemIndex + 1, 0, copy);
        selected = copy.id;
        message = 'Item duplicated.';
      } else {
        const to = indexAfterMove(itemIndex, items.length, action);
        if (to === null) return blocked('The item is already at the edge.');
        const reordered = reorder(items, itemIndex, to);
        items.splice(0, items.length, ...reordered);
        message = `Item moved to position ${to + 1} of ${items.length}.`;
      }
      const nextRow = { ...row, items } as ScanRowDoc;
      const updated = replacePanel(display, {
        ...panel,
        rows: panel.rows.map((candidate) => (candidate.id === row.id ? nextRow : candidate)),
      });
      const reason = placementReason(display, updated);
      return reason ? blocked(reason) : changed(updated, selected, message);
    }
  }

  const variants = display.variants ?? [];
  const variantIndex = variants.findIndex((variant) => variant.id === id);
  if (variantIndex >= 0) {
    const variant = variants[variantIndex];
    if (!variant) return blocked('Rule not found.');
    if (action === 'remove') {
      const updated = { ...display, variants: variants.filter((item) => item.id !== id) };
      return changed(
        withoutRefs(
          updated,
          (variant.header.chips ?? []).map((chip) => chip.id),
        ),
        'rules',
        'Rule removed. Undo to restore it.',
      );
    }
    if (action === 'duplicate') {
      if (variants.length >= 8) return blocked('A scan screen holds eight rules.');
      const used = allIds(display);
      const copy = {
        ...variant,
        id: nextId(used, 'v_'),
        header: {
          ...variant.header,
          ...(variant.header.chips
            ? { chips: variant.header.chips.map((chip) => ({ ...chip, id: nextId(used, 'c_') })) }
            : {}),
        },
      };
      const next = [...variants];
      next.splice(variantIndex + 1, 0, copy);
      return changed({ ...display, variants: next }, copy.id, 'Rule duplicated.');
    }
    const to = indexAfterMove(variantIndex, variants.length, action);
    if (to === null) return blocked('The rule is already at the edge.');
    return changed(
      { ...display, variants: reorder(variants, variantIndex, to) },
      id,
      `Rule moved to position ${to + 1} of ${variants.length}.`,
    );
  }

  const headers = [
    { variant: undefined, header: display.header },
    ...variants.map((variant) => ({ variant: variant.id, header: variant.header })),
  ];
  for (const entry of headers) {
    const chips = entry.header.chips ?? [];
    const index = chips.findIndex((chip) => chip.id === id);
    if (index < 0) continue;
    const chip = chips[index];
    if (!chip) return blocked('Chip not found.');
    let next = [...chips];
    let selected: string | null = id;
    let message: string;
    if (action === 'remove') {
      next = next.filter((item) => item.id !== id);
      selected = entry.variant ?? 'header';
      message = 'Chip removed. Undo to restore it.';
    } else if (action === 'duplicate') {
      if (next.length >= 2) return blocked('A header holds two chips.');
      const copy = { ...chip, id: nextId(allIds(display), 'c_') };
      next.splice(index + 1, 0, copy);
      selected = copy.id;
      message = 'Chip duplicated.';
    } else {
      const to = indexAfterMove(index, next.length, action);
      if (to === null) return blocked('The chip is already at the edge.');
      next = reorder(next, index, to);
      message = `Chip moved to position ${to + 1} of ${next.length}.`;
    }
    const header = { ...entry.header, chips: next };
    const updated = entry.variant
      ? {
          ...display,
          variants: variants.map((variant) =>
            variant.id === entry.variant ? { ...variant, header } : variant,
          ),
        }
      : { ...display, header };
    return changed(action === 'remove' ? withoutRefs(updated, [id]) : updated, selected, message);
  }
  return blocked('This system element cannot be changed.');
}
