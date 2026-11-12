import { Plus } from 'lucide-react';
import { useState } from 'react';
import { DENSITY, density, panelUnits, rowUnits } from '@/passkit/template/scan-display/density.ts';
import type {
  ScanDisplayDoc,
  ScanPanelDoc,
  ScanRowDoc,
} from '@/passkit/template/scan-display/schema.ts';
import { Button } from '../../../../ui/index.ts';
import { PickEdit } from '../controls.tsx';
import { allIds, copyRow, freshRow, reconcileRow, rowIds } from './scan-outline-ids.ts';
import {
  applySelection,
  type Editor,
  focusScanTarget,
  Keys,
  nudgeKey,
  undoToast,
} from './scan-outline-ui.tsx';
import {
  panelName,
  placementReason,
  reorder,
  replacePanel,
  typedManifest,
} from './scan-outline-utils.ts';
import { ScanRowEditor } from './scan-row-editor.tsx';

type RowType = ScanRowDoc['type'];

export { RowList };

const ROWS: { type: RowType; label: string }[] = [
  { type: 'heading', label: 'Heading' },
  { type: 'field', label: 'Field' },
  { type: 'big', label: 'Big value' },
  { type: 'columns', label: 'Columns' },
  { type: 'progress', label: 'Progress' },
  { type: 'money', label: 'Money' },
  { type: 'history', label: 'History' },
  { type: 'image', label: 'Image' },
  { type: 'chips', label: 'Chips' },
  { type: 'list', label: 'List' },
  { type: 'note', label: 'Note' },
  { type: 'divider', label: 'Divider' },
];
const rowName = (row: ScanRowDoc) => ROWS.find((item) => item.type === row.type)?.label ?? row.type;

function rowAdded(
  display: ScanDisplayDoc,
  panel: ScanPanelDoc,
  type: RowType,
): { display: ScanDisplayDoc; row: ScanRowDoc } {
  const row = freshRow(type, allIds(display));
  const rows = [...panel.rows];
  const index =
    type === 'image'
      ? 0
      : type === 'heading' || type === 'divider'
        ? Math.max(0, rows.length - 1)
        : rows.length;
  rows.splice(index, 0, row);
  return { display: replacePanel(display, { ...panel, rows }), row };
}
function addRowReason(editor: Editor, panel: ScanPanelDoc, type: RowType): string | undefined {
  if (panel.rows.length >= 6) return 'A panel holds six rows.';
  const next = rowAdded(editor.display, panel, type);
  const problem = placementReason(editor.display, next.display);
  if (problem) return problem;
  const changed = next.display.panels?.find((item) => item.id === panel.id);
  if (changed && panelUnits(changed) > DENSITY.panelRows && panelUnits(changed) > panelUnits(panel))
    return `A panel holds ${DENSITY.panelRows} units of rows.`;
  const flags = typedManifest(editor.doc).scan?.flags?.length ?? 0;
  if (
    density(next.display, 'ok', flags) > DENSITY.result &&
    density(next.display, 'ok', flags) > density(editor.display, 'ok', flags)
  )
    return `The result holds ${DENSITY.result} units on the successful screen.`;
  return undefined;
}
function candidateMove(
  display: ScanDisplayDoc,
  panel: ScanPanelDoc,
  index: number,
  delta: -1 | 1,
): ScanDisplayDoc | null {
  const to = index + delta;
  if (to < 0 || to >= panel.rows.length) return null;
  return replacePanel(display, { ...panel, rows: reorder(panel.rows, index, to) });
}
function candidateTransfer(
  display: ScanDisplayDoc,
  from: ScanPanelDoc,
  to: ScanPanelDoc,
  row: ScanRowDoc,
): ScanDisplayDoc | null {
  if (to.rows.length >= 6) return null;
  const oldRows = from.rows.filter((item) => item.id !== row.id);
  const targetRows = [...to.rows];
  const index =
    row.type === 'image'
      ? 0
      : row.type === 'heading' || row.type === 'divider'
        ? Math.max(0, targetRows.length - 1)
        : targetRows.length;
  targetRows.splice(index, 0, row);
  return replacePanel(replacePanel(display, { ...from, rows: oldRows }), {
    ...to,
    rows: targetRows,
  });
}
function RowList({ editor: e, panel }: { editor: Editor; panel: ScanPanelDoc }) {
  const [palette, setPalette] = useState(false);
  const panels = e.display.panels ?? [];
  const move = (index: number, delta: -1 | 1) => {
    const row = panel.rows[index];
    if (row) applySelection(e, row.id, delta === -1 ? 'up' : 'down');
  };
  return (
    <div className="grid gap-3">
      <p className="text-xs text-fg-muted">
        {panelUnits(panel)} of {DENSITY.panelRows} row units. Images go first; dividers go between
        rows; headings need a following row.
      </p>
      {panel.rows.length === 0 ? (
        <p className="text-sm text-fg-muted">This panel is empty. Add a row before saving.</p>
      ) : null}
      <ul aria-label={`${panelName(panel)} rows`} className="grid gap-2">
        {panel.rows.map((row, index) => {
          const name = `${rowName(row)} ${index + 1}`;
          const open = e.selected === row.id || rowIds(row).includes(e.selected ?? '');
          const up = candidateMove(e.display, panel, index, -1);
          const down = candidateMove(e.display, panel, index, 1);
          const copy = copyRow(row, allIds(e.display));
          const duplicated = [...panel.rows];
          duplicated.splice(index + 1, 0, copy);
          const copyDoc = replacePanel(e.display, { ...panel, rows: duplicated });
          const copyProblem =
            panel.rows.length >= 6
              ? 'A panel holds six rows'
              : (placementReason(e.display, copyDoc) ?? undefined);
          const removedRows = panel.rows.filter((item) => item.id !== row.id);
          const removeProblem =
            placementReason(e.display, replacePanel(e.display, { ...panel, rows: removedRows })) ??
            undefined;
          return (
            <li key={row.id} className="dz-row" data-open={open || undefined}>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  className="dz-pick"
                  data-target={`scan-display:${row.id}`}
                  aria-expanded={open}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  onClick={() => e.onSelect(open ? panel.id : row.id)}
                  onKeyDown={(event) => nudgeKey(event, (delta) => move(index, delta))}
                >
                  <span className="font-medium text-fg-strong">{rowName(row)}</span>
                  <span className="text-xs text-fg-muted">
                    {rowUnits(row)} {rowUnits(row) === 1 ? 'unit' : 'units'}
                  </span>
                </button>
                <Keys
                  name={name}
                  index={index}
                  length={panel.rows.length}
                  upReason={up ? (placementReason(e.display, up) ?? undefined) : undefined}
                  downReason={down ? (placementReason(e.display, down) ?? undefined) : undefined}
                  onMove={(delta) => move(index, delta)}
                  disabledDuplicate={copyProblem}
                  onDuplicate={() => applySelection(e, row.id, 'duplicate')}
                  disabledRemove={removeProblem}
                  onRemove={() => applySelection(e, row.id, 'remove')}
                />
              </div>
              {open ? (
                <div className="dz-editor grid gap-4">
                  <ScanRowEditor
                    row={row}
                    manifest={e.bindings.manifest}
                    passJson={e.bindings.passJson}
                    role={panel.minRole}
                    onChange={(changed, merge) => {
                      const next = reconcileRow(e.display, row, changed);
                      e.onChange(
                        replacePanel(e.display, {
                          ...panel,
                          rows: panel.rows.map((item) => (item.id === row.id ? next : item)),
                        }),
                        merge,
                      );
                      if (rowIds(changed).length < rowIds(row).length) {
                        e.say('Item removed. Undo to restore it.');
                        undoToast(e);
                        focusScanTarget(row.id);
                      } else if (rowIds(changed).length > rowIds(row).length) {
                        e.say('Item added.');
                      }
                    }}
                  />
                  {panels.length > 1 ? (
                    <PickEdit
                      label="Move row to panel"
                      value="__stay"
                      options={[
                        { value: '__stay', label: 'Choose a panel' },
                        ...panels
                          .filter((item) => item.id !== panel.id)
                          .map((target) => {
                            const next = candidateTransfer(e.display, panel, target, row);
                            const reason = next
                              ? placementReason(e.display, next)
                              : 'Panel is full';
                            return {
                              value: target.id,
                              label: `${panelName(target)}${reason ? ` — ${reason}` : ''}`,
                              disabled: !!reason,
                            };
                          }),
                      ]}
                      onPick={(id) => {
                        const target = panels.find((item) => item.id === id);
                        if (!target) return;
                        const next = candidateTransfer(e.display, panel, target, row);
                        if (next && !placementReason(e.display, next)) {
                          e.onChange(next);
                          e.onSelect(row.id);
                          e.say(`Row moved to ${panelName(target)}.`);
                        }
                      }}
                    />
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <Button
        size="sm"
        variant="outline"
        iconStart={<Plus aria-hidden />}
        disabled={panel.rows.length >= 6}
        aria-expanded={palette}
        onClick={() => setPalette(!palette)}
      >
        Add row
      </Button>
      {palette ? (
        <fieldset className="grid min-w-0 gap-2">
          <legend className="sr-only">Choose row type</legend>
          {ROWS.map(({ type, label }) => {
            const reason = addRowReason(e, panel, type);
            return (
              <div key={type} className="grid gap-0.5">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!!reason}
                  title={reason}
                  onClick={() => {
                    const next = rowAdded(e.display, panel, type);
                    e.onChange(next.display);
                    e.onSelect(next.row.id);
                    setPalette(false);
                    e.say(`${label} row added.`);
                  }}
                >
                  Add {label.toLowerCase()} row
                </Button>
                {reason ? <span className="text-xs text-fg-muted">{reason}</span> : null}
              </div>
            );
          })}
        </fieldset>
      ) : null}
    </div>
  );
}
