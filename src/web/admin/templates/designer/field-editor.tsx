import { DATE_STYLES, NUMBER_STYLES, TEXT_ALIGNMENTS } from '@/passkit/schema/constants.ts';
import { SwitchRow } from '../../../ui/index.ts';
import { fieldSource } from './bindings.ts';
import { useDesigner } from './context.tsx';
import { NameEdit, PickEdit, SourcePicker, TextEdit } from './controls.tsx';
import { readInputs } from './inputs.ts';
import { allKeys, type Dict, type GroupId } from './model.ts';

const NONE = 'none';
const words = (s: string) =>
  s
    .replace(/^PK(?:DateStyle|NumberStyle|TextAlignment)/, '')
    .replace(/([A-Z])/g, ' $1')
    .trim();
const pick = (all: readonly string[]) => [
  { value: NONE, label: 'Default' },
  ...all.map((v) => ({ value: v, label: words(v) })),
];

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Everything about one field: label, key, where its value comes from, and how it is drawn. */
export function FieldEditor({ field, group }: { field: Dict; group: GroupId }) {
  const { doc, edit } = useDesigner();
  const key = str(field.key);
  const source = fieldSource(doc.manifest, key);
  const inputs = readInputs(doc.manifest);
  const optional = source.kind === 'input' && !inputs.find((i) => i.name === source.name)?.required;
  const set = (patch: Record<string, unknown>, merge?: string) =>
    edit({ op: 'field-set', key, patch }, merge);
  const take = (prop: string) => (v: string) => set({ [prop]: v === NONE ? undefined : v });
  const back = group === 'backFields';
  return (
    <div className="dz-editor grid gap-4" data-field-key={key}>
      <TextEdit
        label="Label"
        value={str(field.label)}
        merge={`label:${key}`}
        op={(v) => ({ op: 'field-set', key, patch: { label: v === '' ? undefined : v } })}
      />
      <SourcePicker
        label="Value"
        source={source}
        scanCode
        onChange={(s) => edit({ op: 'field-source', key, source: s, optional })}
      />
      {source.kind === 'static' ? (
        <TextEdit
          label="Text"
          value={str(field.value)}
          merge={`value:${key}`}
          op={(v) => ({ op: 'field-value', key, value: v })}
        />
      ) : source.kind === 'expr' ? (
        <TextEdit
          label="Expression"
          value={source.expr}
          merge={`expr:${key}`}
          help="Use {{input}} for an input."
          op={(v) => ({ op: 'field-source', key, source: { kind: 'expr', expr: v }, optional })}
        />
      ) : (
        <p className="text-xs text-fg-muted">The sample value of the input shows in the preview.</p>
      )}
      <TextEdit
        label="Change message"
        value={str(field.changeMessage)}
        merge={`msg:${key}`}
        placeholder="Your seat is now %@"
        help="Shown when the value changes. It must contain %@."
        error={
          field.changeMessage !== undefined && !str(field.changeMessage).includes('%@')
            ? 'Add %@ where the new value goes.'
            : undefined
        }
        op={(v) => ({ op: 'field-set', key, patch: { changeMessage: v === '' ? undefined : v } })}
      />
      {group !== 'primaryFields' && !back ? (
        <PickEdit
          label="Alignment"
          value={str(field.textAlignment) || NONE}
          options={pick(TEXT_ALIGNMENTS)}
          onPick={take('textAlignment')}
        />
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <PickEdit
          label="Date style"
          value={str(field.dateStyle) || NONE}
          options={pick(DATE_STYLES)}
          onPick={take('dateStyle')}
        />
        <PickEdit
          label="Time style"
          value={str(field.timeStyle) || NONE}
          options={pick(DATE_STYLES)}
          onPick={take('timeStyle')}
        />
      </div>
      <PickEdit
        label="Number style"
        value={str(field.numberStyle) || NONE}
        options={pick(NUMBER_STYLES)}
        onPick={take('numberStyle')}
      />
      {back ? (
        <SwitchRow
          label="Link"
          help="Shows the value as a tappable link."
          checked={field.attributedValue !== undefined}
          onCheckedChange={(on) => edit({ op: 'field-link', key, on, optional })}
        />
      ) : null}
      <NameEdit
        label="Key"
        value={key}
        help="Identifies the field in the pass. Unique."
        problem={(text) =>
          text === ''
            ? 'A key is required.'
            : allKeys(doc.passJson).includes(text)
              ? 'Another field has this key.'
              : null
        }
        onCommit={(to) => edit({ op: 'field-key', key, to })}
      />
    </div>
  );
}
