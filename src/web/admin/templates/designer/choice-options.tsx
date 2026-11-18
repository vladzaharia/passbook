import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { Button, IconButton, Input } from '../../../ui/index.ts';
import {
  addOption,
  type ChoiceOption,
  MAX_OPTIONS,
  optionsProblem,
  slugOf,
} from './choice-model.ts';
import { useDesigner } from './context.tsx';
import type { InputSpec } from './inputs.ts';

/** A value follows its label until someone types a value of their own. */
const follows = (o: ChoiceOption) => o.value === slugOf(o.label) || /^option_\d+$/.test(o.value);

function moved<T>(list: readonly T[], from: number, to: number): T[] {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}

/** The options of a choice input: label and stored value per row, in order. */
export function ChoiceOptions({ spec }: { spec: InputSpec }) {
  const { edit, readOnly } = useDesigner();
  const options = spec.options ?? [];
  const problem = optionsProblem(options);
  const write = (next: ChoiceOption[], patch: Partial<InputSpec> = {}, merge?: string) =>
    edit({ op: 'input-set', name: spec.name, patch: { options: next, ...patch } }, merge);
  /** Keeps the sample and default on the option they named when its value changes. */
  const remap = (from: string, to: string): Partial<InputSpec> => ({
    ...(spec.sample === from ? { sample: to } : {}),
    ...(spec.default === from ? { default: to } : {}),
  });
  function change(i: number, patch: Partial<ChoiceOption>, key: 'label' | 'value') {
    const old = options[i];
    if (!old) return;
    let value = patch.value ?? old.value;
    if (key === 'label' && follows(old)) {
      const slug = slugOf(patch.label ?? '');
      if (slug && !options.some((o, j) => j !== i && o.value === slug)) value = slug;
    }
    const next = options.map((o, j) => (j === i ? { ...o, ...patch, value } : o));
    write(next, value !== old.value ? remap(old.value, value) : {}, `opt-${key}:${spec.name}:${i}`);
  }
  function remove(i: number) {
    const gone = options[i];
    const next = options.filter((_o, j) => j !== i);
    const first = next[0]?.value ?? '';
    write(next, {
      ...(gone && spec.sample === gone.value ? { sample: first } : {}),
      ...(gone && spec.default === gone.value ? { default: '' } : {}),
    });
  }
  return (
    <fieldset className="grid gap-2 border-0 p-0">
      <legend className="mb-1 text-sm font-medium text-fg-strong">Options</legend>
      <ul aria-label={`${spec.label} options`} className="grid gap-2">
        {options.map((o, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; the value is editable
          <li key={i} className="flex items-center gap-1">
            <Input
              aria-label={`Option ${i + 1} label`}
              value={o.label}
              readOnly={readOnly}
              className="min-w-0 flex-1"
              onChange={(e) => change(i, { label: e.target.value }, 'label')}
            />
            <Input
              aria-label={`Option ${i + 1} value`}
              value={o.value}
              readOnly={readOnly}
              className="w-28 min-w-0 font-mono text-xs"
              aria-invalid={
                o.value.trim() === '' || options.some((p, j) => j < i && p.value === o.value)
              }
              onChange={(e) => change(i, { value: e.target.value }, 'value')}
            />
            <IconButton
              label={`Move option ${i + 1} up`}
              icon={<ArrowUp aria-hidden />}
              variant="ghost"
              size="sm"
              disabled={i === 0}
              onClick={() => write(moved(options, i, i - 1))}
            />
            <IconButton
              label={`Move option ${i + 1} down`}
              icon={<ArrowDown aria-hidden />}
              variant="ghost"
              size="sm"
              disabled={i === options.length - 1}
              onClick={() => write(moved(options, i, i + 1))}
            />
            <IconButton
              label={`Remove option ${i + 1}`}
              icon={<Trash2 aria-hidden />}
              variant="ghost"
              size="sm"
              disabled={options.length <= 1}
              onClick={() => remove(i)}
            />
          </li>
        ))}
      </ul>
      {problem ? (
        <p role="alert" className="text-xs text-danger">
          {problem}
        </p>
      ) : null}
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        iconStart={<Plus aria-hidden />}
        disabled={options.length >= MAX_OPTIONS}
        onClick={() => write(addOption(options))}
      >
        Add option
      </Button>
    </fieldset>
  );
}
