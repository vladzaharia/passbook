import { Plus } from 'lucide-react';
import type { ScanChipDoc, ScanDisplayDoc } from '@/passkit/template/scan-display/schema.ts';
import { Button, SwitchRow } from '../../../../ui/index.ts';
import { PickEdit } from '../controls.tsx';
import { ScanConditionField } from './scan-condition-fields.tsx';
import { ScanIconField, ScanRoleField } from './scan-fields.tsx';
import { allIds, nextId } from './scan-outline-ids.ts';
import { applySelection, type Editor, Keys, nudgeKey, undoToast } from './scan-outline-ui.tsx';
import { chipName, withoutRefs } from './scan-outline-utils.ts';
import { ScanTextField } from './scan-text-fields.tsx';

type Header = ScanDisplayDoc['header'];

export { Chips, headerOf, setHeader };

function headerOf(display: ScanDisplayDoc, variant?: string): Header {
  return variant
    ? (display.variants?.find((item) => item.id === variant)?.header ?? {})
    : display.header;
}
function setHeader(display: ScanDisplayDoc, header: Header, variant?: string): ScanDisplayDoc {
  return variant
    ? {
        ...display,
        variants: (display.variants ?? []).map((item) =>
          item.id === variant ? { ...item, header } : item,
        ),
      }
    : { ...display, header };
}

function Chips({ editor: e, variant }: { editor: Editor; variant?: string }) {
  const header = headerOf(e.display, variant);
  const chips = header.chips ?? [];
  const set = (next: ScanChipDoc[], merge?: string, removed: string[] = []) =>
    e.onChange(
      withoutRefs(setHeader(e.display, { ...header, chips: next }, variant), removed),
      merge,
    );
  const move = (index: number, delta: -1 | 1) => {
    const chip = chips[index];
    if (chip) applySelection(e, chip.id, delta === -1 ? 'up' : 'down');
  };
  return (
    <div className="grid gap-2">
      {variant ? (
        <SwitchRow
          label="Override chips"
          help="Otherwise this variant uses the default chips."
          checked={header.chips !== undefined}
          onCheckedChange={(checked) => {
            const removed = checked ? [] : chips.map((chip) => chip.id);
            e.onChange(
              withoutRefs(
                setHeader(e.display, { ...header, chips: checked ? [] : undefined }, variant),
                removed,
              ),
            );
            if (removed.length) undoToast(e);
          }}
        />
      ) : null}
      {!variant || header.chips !== undefined ? (
        <>
          <ul aria-label={variant ? 'Variant chips' : 'Header chips'} className="grid gap-2">
            {chips.map((chip, index) => {
              const name = chipName(chip, index);
              const open = e.selected === chip.id;
              const update = (next: ScanChipDoc, merge?: string) =>
                set(
                  chips.map((item) => (item.id === chip.id ? next : item)),
                  merge,
                );
              return (
                <li className="dz-row" data-open={open || undefined} key={chip.id}>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      className="dz-pick"
                      data-target={`scan-display:${chip.id}`}
                      aria-expanded={open}
                      aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                      onClick={() => e.onSelect(open ? (variant ?? 'header') : chip.id)}
                      onKeyDown={(event) => nudgeKey(event, (delta) => move(index, delta))}
                    >
                      {name}
                    </button>
                    <Keys
                      name={name}
                      index={index}
                      length={chips.length}
                      onMove={(delta) => move(index, delta)}
                      onDuplicate={() => applySelection(e, chip.id, 'duplicate')}
                      disabledDuplicate={chips.length >= 2 ? 'A header holds two chips' : undefined}
                      onRemove={() => applySelection(e, chip.id, 'remove')}
                    />
                  </div>
                  {open ? (
                    <div className="dz-editor grid gap-4">
                      <ScanTextField
                        label="Chip text"
                        value={chip.text}
                        manifest={e.bindings.manifest}
                        passJson={e.bindings.passJson}
                        audienceRole={chip.minRole}
                        mergeKey={`scan:${chip.id}:text`}
                        onChange={(text, merge) => update({ ...chip, text: text ?? '' }, merge)}
                      />
                      <ScanIconField
                        value={chip.icon}
                        onChange={(icon) => update({ ...chip, icon })}
                      />
                      <PickEdit
                        label="Tone"
                        value={chip.tone}
                        options={['neutral', 'teal', 'violet', 'gold'].map((value) => ({
                          value,
                          label: value[0]?.toUpperCase() + value.slice(1),
                        }))}
                        onPick={(tone) => update({ ...chip, tone: tone as ScanChipDoc['tone'] })}
                      />
                      <ScanRoleField
                        value={chip.minRole}
                        onChange={(minRole) => update({ ...chip, minRole })}
                      />
                      <ScanConditionField
                        label="Show when"
                        value={chip.when}
                        manifest={e.bindings.manifest}
                        passJson={e.bindings.passJson}
                        audienceRole={chip.minRole}
                        mergeKey={`scan:${chip.id}:when`}
                        onChange={(when, merge) => update({ ...chip, when }, merge)}
                      />
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
            disabled={chips.length >= 2}
            onClick={() => {
              const chip: ScanChipDoc = {
                id: nextId(allIds(e.display), 'c_'),
                text: '',
                tone: 'neutral',
              };
              set([...chips, chip]);
              e.onSelect(chip.id);
              e.say('Chip added.');
            }}
          >
            Add chip
          </Button>
          {chips.length >= 2 ? (
            <p className="text-xs text-fg-muted">A header holds two chips.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
