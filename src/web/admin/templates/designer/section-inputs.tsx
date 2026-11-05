import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { removeWithTransition } from '../../../lib/motion.ts';
import { Button, IconButton, SwitchRow, toast } from '../../../ui/index.ts';
import { inputUses } from './bindings.ts';
import { useDesigner } from './context.tsx';
import { NameEdit, PickEdit, TextEdit } from './controls.tsx';
import {
  INPUT_TYPES,
  type InputSpec,
  nameProblem,
  newInput,
  type PickType,
  readInputs,
  sampleFor,
  scalarInputs,
  typeLabel,
} from './inputs.ts';
import { isRecord } from './model.ts';

function InputEditor({ spec, names }: { spec: InputSpec; names: string[] }) {
  const { edit } = useDesigner();
  const set = (patch: Partial<InputSpec>, merge?: string) =>
    edit({ op: 'input-set', name: spec.name, patch }, merge);
  return (
    <div className="dz-editor grid gap-4">
      <TextEdit
        label="Label"
        value={spec.label}
        merge={`in-label:${spec.name}`}
        help="Shown on the form when creating a pass."
        op={(v) => ({ op: 'input-set', name: spec.name, patch: { label: v } })}
      />
      {spec.type === 'list' ? (
        <p className="text-sm text-fg-muted">A list. Its rows and sample stay as they are.</p>
      ) : (
        <PickEdit
          label="Type"
          value={spec.type}
          options={INPUT_TYPES}
          onPick={(v) =>
            set({ type: v as PickType, sample: sampleFor(v as PickType), default: '' })
          }
        />
      )}
      <SwitchRow
        label="Required"
        checked={spec.required}
        onCheckedChange={(required) => set({ required })}
      />
      {spec.type === 'list' ? null : (
        <div className="grid gap-4 sm:grid-cols-2">
          <TextEdit
            label="Default"
            value={spec.default}
            merge={`in-default:${spec.name}`}
            op={(v) => ({ op: 'input-set', name: spec.name, patch: { default: v } })}
          />
          <TextEdit
            label="Sample"
            value={spec.sample}
            merge={`in-sample:${spec.name}`}
            help="Shown in the preview."
            error={
              spec.required && spec.sample === '' ? 'A required input needs a sample.' : undefined
            }
            op={(v) => ({ op: 'input-set', name: spec.name, patch: { sample: v } })}
          />
        </div>
      )}
      <NameEdit
        label="Name"
        value={spec.name}
        help="Used in expressions as {{name}}."
        problem={(text) =>
          nameProblem(
            text,
            names.filter((n) => n !== spec.name),
          )
        }
        onCommit={(name) => edit({ op: 'input-set', name: spec.name, patch: { name } })}
      />
    </div>
  );
}

const exprOptions = (specs: InputSpec[]) => [
  { value: 'none', label: 'None' },
  ...scalarInputs(specs).map((s) => ({ value: `{{${s.name}}}`, label: s.label })),
];

/** What removing the input takes with it, in one line. */
function usedBy(uses: { fields: number; messaging: boolean }): string {
  const parts = [
    ...(uses.fields > 0 ? [`${uses.fields} ${uses.fields === 1 ? 'field' : 'fields'}`] : []),
    ...(uses.messaging ? ['Messages'] : []),
  ];
  return `Used by ${parts.join(' and ')}. Remove?`;
}

export function InputsSection() {
  const { doc, edit, state, select, dispatch } = useDesigner();
  const [confirm, setConfirm] = useState<string | null>(null);
  function remove(spec: InputSpec) {
    setConfirm(null);
    removeWithTransition(() => {
      edit({ op: 'input-remove', name: spec.name });
      toast.undo(`${spec.label} removed`, () => dispatch({ type: 'undo' }));
    });
  }
  const specs = readInputs(doc.manifest);
  const names = specs.map((s) => s.name);
  const open = state.select.section === 'inputs' ? state.select.key : undefined;
  const added = state.added?.kind === 'input' ? state.added : null;
  const display = isRecord(doc.manifest.display) ? doc.manifest.display : {};
  const show = (v: unknown) =>
    typeof v === 'string' && names.some((n) => v === `{{${n}}}`) ? v : v ? '__custom' : 'none';
  const withCustom = (v: unknown) => {
    const base = exprOptions(specs);
    return typeof v === 'string' && show(v) === '__custom'
      ? [...base, { value: '__custom', label: v }]
      : base;
  };
  return (
    <div className="grid gap-4">
      <ul aria-label="Inputs" className="grid gap-1.5">
        {specs.map((spec, i) => (
          <li
            key={spec.name}
            data-row-id={`input:${spec.name}`}
            className="dz-row"
            data-new={added?.key === spec.name ? added.n : undefined}
            data-open={open === spec.name || undefined}
          >
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="dz-pick"
                data-target={`inputs:${spec.name}`}
                aria-expanded={open === spec.name}
                onClick={() =>
                  select({ section: 'inputs', key: open === spec.name ? undefined : spec.name })
                }
              >
                <span className="truncate font-medium text-fg-strong">{spec.label}</span>
                <span className="truncate text-xs text-fg-muted">
                  {typeLabel(spec.type)}
                  {spec.required ? ', required' : ''}
                </span>
              </button>
              <IconButton
                label={`Move ${spec.label} up`}
                icon={<ArrowUp aria-hidden />}
                variant="ghost"
                size="sm"
                disabled={i === 0}
                onClick={() => edit({ op: 'input-move', name: spec.name, to: i - 1 })}
              />
              <IconButton
                label={`Move ${spec.label} down`}
                icon={<ArrowDown aria-hidden />}
                variant="ghost"
                size="sm"
                disabled={i === specs.length - 1}
                onClick={() => edit({ op: 'input-move', name: spec.name, to: i + 1 })}
              />
              <IconButton
                label={`Remove ${spec.label}`}
                icon={<Trash2 aria-hidden />}
                variant="ghost"
                size="sm"
                onClick={() => {
                  const uses = inputUses(doc.manifest, spec.name);
                  if (uses.fields > 0 || uses.messaging) setConfirm(spec.name);
                  else remove(spec);
                }}
              />
            </div>
            {confirm === spec.name ? (
              <div role="alert" className="flex flex-wrap items-center gap-2 px-1 pt-2 pb-1">
                <span className="min-w-0 flex-1 text-sm text-fg-strong">
                  {usedBy(inputUses(doc.manifest, spec.name))}
                </span>
                <Button size="sm" variant="outline" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => remove(spec)}>
                  Remove
                </Button>
              </div>
            ) : null}
            {open === spec.name ? <InputEditor spec={spec} names={names} /> : null}
          </li>
        ))}
      </ul>
      {specs.length === 0 ? (
        <p className="text-sm text-fg-muted">
          No inputs. Passes from this template have nothing to fill in.
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        iconStart={<Plus aria-hidden />}
        onClick={() => edit({ op: 'input-add', spec: newInput(specs) })}
      >
        Add input
      </Button>
      <div className="grid gap-4 border-t border-border pt-4">
        <PickEdit
          label="List title"
          value={show(display.title)}
          options={withCustom(display.title)}
          help="What a pass is called in lists."
          onPick={(v) =>
            v !== '__custom' && edit({ op: 'display', part: 'title', expr: v === 'none' ? '' : v })
          }
        />
        <PickEdit
          label="List subtitle"
          value={show(display.subtitle)}
          options={withCustom(display.subtitle)}
          onPick={(v) =>
            v !== '__custom' &&
            edit({ op: 'display', part: 'subtitle', expr: v === 'none' ? '' : v })
          }
        />
      </div>
    </div>
  );
}
