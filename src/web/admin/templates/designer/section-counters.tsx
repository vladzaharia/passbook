import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, FormField, IconButton, Input, NumberField, SwitchRow } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import { PickEdit, TextEdit } from './controls.tsx';
import {
  COUNTER_MAX,
  type CounterView,
  hasScan,
  leftText,
  readCounters,
  SIZE_MAX,
  SIZE_MIN,
} from './counters.ts';
import { countInputs } from './stamps.ts';

/** Typing stays local: a goal applies once it is a whole number in range. */
function GoalField({
  id,
  value,
  min,
  max,
  art,
}: {
  id: string;
  value: number;
  min: number;
  max: number;
  art: boolean;
}) {
  const { edit } = useDesigner();
  const [text, setText] = useState<string | null>(null);
  return (
    <FormField label="Goal" help={art ? 'With strip art, 3 to 20.' : `${min} to ${max}.`}>
      {(c) => (
        <NumberField
          {...c}
          min={min}
          max={max}
          value={text === null ? value : text === '' ? null : Number(text)}
          onBlur={() => setText(null)}
          onValueChange={(n) => {
            setText(n === null ? '' : String(n));
            if (n !== null && Number.isInteger(n) && n >= min && n <= max)
              edit({ op: 'counter-set', id, patch: { size: n } }, `counter-size:${id}`);
          }}
        />
      )}
    </FormField>
  );
}

function CounterCard({ view }: { view: CounterView }) {
  const { doc, edit, readOnly } = useDesigner();
  const fixed = typeof view.size === 'number' ? view.size : undefined;
  const min = view.art ? 3 : SIZE_MIN;
  const max = view.art ? 20 : SIZE_MAX;
  return (
    <fieldset
      disabled={readOnly}
      className="m-0 grid min-w-0 gap-4 rounded-lg border border-border p-3"
    >
      <legend className="sr-only">{view.label}</legend>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-fg-strong">{view.label}</p>
          <p className="text-xs text-fg-muted">
            {fixed === undefined ? 'Size set per pass.' : `Full: ${leftText(fixed)}`}
          </p>
        </div>
        <IconButton
          label={`Remove ${view.label}`}
          icon={<Trash2 aria-hidden />}
          variant="ghost"
          size="sm"
          onClick={() => edit({ op: 'counter-remove', id: view.id })}
        />
      </div>
      <TextEdit
        label="Label"
        value={view.label}
        merge={`counter-label:${view.id}`}
        op={(label) => ({ op: 'counter-set', id: view.id, patch: { label } })}
        help="Shown on the pass beside the count."
      />
      {fixed === undefined ? (
        <p className="text-xs text-fg-muted">
          The goal comes from the{' '}
          {view.size && typeof view.size === 'object' ? view.size.input : ''} input.
        </p>
      ) : (
        <GoalField id={view.id} value={fixed} min={min} max={max} art={view.art} />
      )}
      <PickEdit
        label="Count from"
        value={view.input}
        options={countInputs(doc.manifest)}
        help="The whole-number input that holds what is left."
        onPick={(input) => edit({ op: 'counter-set', id: view.id, patch: { input } })}
      />
      <SwitchRow
        label="Use one at the scanner"
        help="Takes one off."
        checked={hasScan(doc, view, 'use')}
        disabled={fixed === undefined}
        onCheckedChange={(on) => edit({ op: 'counter-scan', id: view.id, kind: 'use', on })}
      />
      <SwitchRow
        label="Refill at the scanner"
        help={fixed === undefined ? 'Needs a fixed goal.' : `Resets it to ${fixed}. Managers only.`}
        checked={hasScan(doc, view, 'refill')}
        disabled={fixed === undefined}
        onCheckedChange={(on) => edit({ op: 'counter-scan', id: view.id, kind: 'refill', on })}
      />
    </fieldset>
  );
}

/** Counts that go down ("7 left"): define one, label it, set the goal, refill it at the scanner. */
export function CountersSection() {
  const { doc, edit, readOnly } = useDesigner();
  const counters = readCounters(doc);
  const [name, setName] = useState('');
  const add = () => {
    if (!name.trim()) return;
    edit({ op: 'counter-add', label: name });
    setName('');
  };
  return (
    <div className="grid gap-4">
      {counters.map((c) => (
        <CounterCard key={c.id} view={c} />
      ))}
      {counters.length < COUNTER_MAX ? (
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            add();
          }}
        >
          <FormField label="New counter" className="min-w-0 flex-1">
            {(c) => (
              <Input
                {...c}
                placeholder="Visits"
                maxLength={40}
                disabled={readOnly}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </FormField>
          <Button type="submit" variant="outline" disabled={readOnly || !name.trim()}>
            Add
          </Button>
        </form>
      ) : null}
    </div>
  );
}
