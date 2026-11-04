import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, SwitchRow } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { NameEdit, PickEdit, TextEdit } from './controls.tsx';
import {
  INPUT_TYPES,
  type InputSpec,
  type InputType,
  nameProblem,
  newInput,
  readInputs,
  sampleFor,
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
      <PickEdit
        label="Type"
        value={spec.type}
        options={INPUT_TYPES}
        onPick={(v) =>
          set({ type: v as InputType, sample: sampleFor(v as InputType), default: '' })
        }
      />
      <SwitchRow
        label="Required"
        checked={spec.required}
        onCheckedChange={(required) => set({ required })}
      />
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
  ...specs.map((s) => ({ value: `{{${s.name}}}`, label: s.label })),
];

export function InputsSection() {
  const { doc, edit, state, select } = useDesigner();
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
                  {INPUT_TYPES.find((t) => t.value === spec.type)?.label}
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
                onClick={() => edit({ op: 'input-remove', name: spec.name })}
              />
            </div>
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
