import { ChevronRight, Plus } from 'lucide-react';
import { useId, useState } from 'react';
import { DENSITY, DOC_SCREENS, panelUnits } from '@/passkit/template/scan-display/density.ts';
import { PRESET_ORDER, PRESETS, slotsFound } from '@/passkit/template/scan-display/presets.ts';
import type { ScanPanelDoc, ScanPresetId } from '@/passkit/template/scan-display/schema.ts';
import { inputProps } from '@/passkit/template/scan-display/scope.ts';
import { DEFAULT_SCAN_ACTION } from '@/shared/scan-defaults.ts';
import { Badge, Button, CheckboxField, OptionTile, SwitchRow } from '../../../../ui/index.ts';
import { PickEdit } from '../controls.tsx';
import { ScanConditionField } from './scan-condition-fields.tsx';
import { ScanIconField, ScanRoleField } from './scan-fields.tsx';
import { allIds, copyPanel, nextId, rowIds } from './scan-outline-ids.ts';
import { RowList } from './scan-outline-rows.tsx';
import { applySelection, type Editor, Keys, nudgeKey } from './scan-outline-ui.tsx';
import {
  allowedPaths,
  labelText,
  panelName,
  placementReason,
  replacePanel,
  resetPanel,
  safePreset,
  typedManifest,
} from './scan-outline-utils.ts';
import { ScanTextField } from './scan-text-fields.tsx';

export { Palette, PanelSection };

function PanelSettings({ editor: e, panel }: { editor: Editor; panel: ScanPanelDoc }) {
  const update = (patch: Partial<ScanPanelDoc>, merge?: string) =>
    e.onChange(replacePanel(e.display, { ...panel, ...patch }), merge);
  const screens = panel.on ?? [...DOC_SCREENS];
  const actions = typedManifest(e.doc).scan?.actions ?? [DEFAULT_SCAN_ACTION];
  const actionIds = panel.actions ?? [];
  const allActions = [
    ...actions.map((action, index) => ({
      id: action.id,
      label: labelText(action.label, `Action ${index + 1}`),
    })),
    ...actionIds
      .filter((id) => !actions.some((action) => action.id === id))
      .map((id) => ({ id, label: 'Missing action' })),
  ];
  return (
    <div className="grid gap-4">
      <ScanTextField
        label="Panel title"
        value={panel.title}
        manifest={e.bindings.manifest}
        passJson={e.bindings.passJson}
        audienceRole={panel.minRole}
        optional
        mergeKey={`scan:${panel.id}:title`}
        onChange={(title, merge) => update({ title }, merge)}
      />
      <ScanIconField value={panel.icon} onChange={(icon) => update({ icon })} />
      <PickEdit
        label="Tone"
        value={panel.tone ?? 'neutral'}
        options={['neutral', 'teal', 'violet', 'gold'].map((value) => ({
          value,
          label: value[0]?.toUpperCase() + value.slice(1),
        }))}
        onPick={(tone) => update({ tone: tone as ScanPanelDoc['tone'] })}
      />
      <ScanRoleField value={panel.minRole} onChange={(minRole) => update({ minRole })} />
      <ScanConditionField
        label="Show when"
        value={panel.when}
        manifest={e.bindings.manifest}
        passJson={e.bindings.passJson}
        audienceRole={panel.minRole}
        mergeKey={`scan:${panel.id}:when`}
        onChange={(when, merge) => update({ when }, merge)}
      />
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium text-fg-strong">Show on</legend>
        {DOC_SCREENS.map((screen) => (
          <CheckboxField
            key={screen}
            label={
              screen === 'heads_up' ? 'Heads-up' : screen === 'ok' ? 'Successful result' : 'Ready'
            }
            checked={screens.includes(screen)}
            disabled={screens.length === 1 && screens.includes(screen)}
            onCheckedChange={(checked) => {
              const on =
                checked === true ? [...screens, screen] : screens.filter((item) => item !== screen);
              update({ on: on.length === DOC_SCREENS.length ? undefined : on });
            }}
          />
        ))}
        <p className="text-xs text-fg-muted">
          At least one screen is required. Refused screens never show panels.
        </p>
      </fieldset>
      <SwitchRow
        label="Limit to selected actions"
        checked={panel.actions !== undefined}
        onCheckedChange={(checked) => update({ actions: checked ? [] : undefined })}
      />
      {panel.actions !== undefined ? (
        <fieldset className="grid gap-2">
          <legend className="mb-2 text-sm font-medium text-fg-strong">Actions</legend>
          {allActions.map((action) => (
            <CheckboxField
              key={action.id}
              label={action.label}
              checked={actionIds.includes(action.id)}
              onCheckedChange={(checked) =>
                update({
                  actions:
                    checked === true
                      ? [...actionIds, action.id]
                      : actionIds.filter((id) => id !== action.id),
                })
              }
            />
          ))}
          {allActions.length === 0 ? (
            <p className="text-xs text-fg-muted">There are no template actions to select.</p>
          ) : null}
        </fieldset>
      ) : null}
      <RowList editor={e} panel={panel} />
    </div>
  );
}

function PanelSection({
  editor: e,
  panel,
  index,
  confirm,
}: {
  editor: Editor;
  panel: ScanPanelDoc;
  index: number;
  confirm: (operation: 'remove' | 'reset', panel: ScanPanelDoc) => void;
}) {
  const panels = e.display.panels ?? [];
  const open =
    e.selected === panel.id || panel.rows.some((row) => rowIds(row).includes(e.selected ?? ''));
  const name = panelName(panel);
  const region = useId();
  const move = (delta: -1 | 1) => applySelection(e, panel.id, delta === -1 ? 'up' : 'down');
  const duplicate = copyPanel(panel, allIds(e.display));
  const added = [...panels];
  added.splice(index + 1, 0, duplicate);
  const problem =
    panels.length >= 6
      ? 'A scan screen holds six panels'
      : (placementReason(e.display, { ...e.display, panels: added }) ?? undefined);
  const reset = resetPanel(e.doc, e.display, panel);
  return (
    <li className="dz-section" data-open={open || undefined}>
      <div className="flex items-center">
        <h2 className="min-w-0 flex-1">
          <button
            type="button"
            className="dz-head"
            data-target={`scan-display:${panel.id}`}
            aria-expanded={open}
            aria-controls={region}
            aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
            onClick={() => e.onSelect(open ? null : panel.id)}
            onKeyDown={(event) => nudgeKey(event, move)}
          >
            <ChevronRight aria-hidden className={`size-4 shrink-0 ${open ? 'rotate-90' : ''}`} />
            <span className="min-w-0 flex-1 truncate text-left">{name}</span>
            <Badge>
              {panelUnits(panel)} / {DENSITY.panelRows}
            </Badge>
          </button>
        </h2>
        <Keys
          name={`panel ${name}`}
          index={index}
          length={panels.length}
          onMove={move}
          disabledDuplicate={problem}
          onDuplicate={() => applySelection(e, panel.id, 'duplicate')}
          onRemove={() => confirm('remove', panel)}
        />
      </div>
      {open ? (
        <section id={region} aria-label={`${name} panel`} className="dz-panel grid gap-4">
          <PanelSettings editor={e} panel={panel} />
          {panel.preset ? (
            <div className="grid gap-1">
              <Button
                size="sm"
                variant="outline"
                disabled={!reset}
                onClick={() => confirm('reset', panel)}
              >
                Reset to {PRESETS[panel.preset.id].title} preset
              </Button>
              {!reset ? (
                <p className="text-xs text-fg-muted">
                  Remove custom rows first; the rebuilt preset and custom rows exceed six.
                </p>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </li>
  );
}

function Palette({ editor: e, initial = false }: { editor: Editor; initial?: boolean }) {
  const [choice, setChoice] = useState<ScanPresetId | 'empty'>('empty');
  const [show, setShow] = useState(initial);
  const full = (e.display.panels ?? []).length >= 6;
  const manifest = typedManifest(e.doc);
  const paths = allowedPaths(e.doc);
  const safeManifest = {
    ...manifest,
    inputs: {
      ...manifest.inputs,
      properties: Object.fromEntries(
        Object.entries(inputProps(manifest)).filter(([name]) => paths.has(`inputs.${name}`)),
      ),
    },
  };
  const add = () => {
    if (full) return;
    const used = allIds(e.display);
    const panel =
      choice === 'empty'
        ? { id: nextId(used, 'p_'), title: 'Panel', rows: [] }
        : copyPanel(safePreset(e.doc, choice), used);
    e.onChange({ ...e.display, panels: [...(e.display.panels ?? []), panel] });
    e.onSelect(panel.id);
    setShow(false);
    e.say(`${panelName(panel)} added.`);
  };
  return (
    <div className="grid gap-3">
      {!initial ? (
        <Button
          size="sm"
          variant="outline"
          iconStart={<Plus aria-hidden />}
          disabled={full}
          onClick={() => setShow(!show)}
          aria-expanded={show}
        >
          Add panel
        </Button>
      ) : null}
      {full ? <p className="text-xs text-fg-muted">A scan screen holds six panels.</p> : null}
      {show && !full ? (
        <fieldset className="grid gap-3">
          <legend className="mb-2 text-sm font-medium text-fg-strong">
            Choose a starting panel
          </legend>
          <p className="text-xs text-fg-muted">
            Presets add ordinary editable rows. An empty panel needs a row before it can be saved.
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {PRESET_ORDER.map((id) => (
              <OptionTile
                key={id}
                name="scan-preset"
                value={id}
                label={PRESETS[id].title}
                description={`${slotsFound(safeManifest, PRESETS[id])} found`}
                checked={choice === id}
                onSelect={() => setChoice(id)}
              />
            ))}
            <OptionTile
              name="scan-preset"
              value="empty"
              label="Empty panel"
              description="Choose rows yourself"
              checked={choice === 'empty'}
              onSelect={() => setChoice('empty')}
            />
          </div>
          <Button size="sm" onClick={add}>
            Add {choice === 'empty' ? 'empty panel' : PRESETS[choice].title}
          </Button>
        </fieldset>
      ) : null}
    </div>
  );
}
