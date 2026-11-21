import { useState } from 'react';
import type { AccessManifest, ValidationIssue } from '@/passkit/types.ts';
import { CheckboxField, FormField, Input, NumberField, SwitchRow } from '../../../../ui/index.ts';
import { useDesigner } from '../context.tsx';
import { PickEdit } from '../controls.tsx';
import { textInputs } from './model.ts';

const NEVER = '__never';
const GAP_DEFAULT = 120;
const WAIT_DEFAULT = 10;

/** Values typed as "Suspended, Frozen"; applied when the field is left. */
function ValuesEdit({ value, onCommit }: { value: string[]; onCommit: (v: string[]) => void }) {
  const [text, setText] = useState(value.join(', '));
  const commit = () => {
    const next = text
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    if (next.length > 0) onCommit(next);
    else setText(value.join(', '));
  };
  return (
    <FormField label="Values" help="Separate with commas.">
      {(control) => (
        <Input
          {...control}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
        />
      )}
    </FormField>
  );
}

/** How visits count, the wait between entries, and what suspends a card. */
export function Rules({
  access,
  issues,
}: {
  access: AccessManifest;
  issues: readonly ValidationIssue[];
}) {
  const { doc, edit } = useDesigner();
  const rules = access.rules ?? {};
  const setRules = (next: NonNullable<AccessManifest['rules']>, merge?: string) =>
    edit({ op: 'access-rules', rules: next }, merge);
  const range = issues.find((i) => i.code === 'ACCESS_RULES_RANGE')?.message;
  const inputs = textInputs(doc.manifest);
  const suspend = access.suspend;
  const chosen = inputs.find((i) => i.name === suspend?.input);
  const waiting = rules.reentryMinutes !== undefined && rules.reentryMinutes !== null;
  return (
    <div className="grid gap-4">
      <FormField
        label="Count as one visit within"
        help="Entries inside this time are one visit. 0 counts every entry."
        error={range}
      >
        {(control) => (
          <NumberField
            {...control}
            unit="min"
            min={0}
            max={720}
            value={rules.visitGapMinutes ?? GAP_DEFAULT}
            onValueChange={(v) =>
              setRules({ ...rules, ...(v === null ? {} : { visitGapMinutes: v }) }, 'access-gap')
            }
          />
        )}
      </FormField>
      <SwitchRow
        label="Wait between entries"
        checked={waiting}
        onCheckedChange={(on) => setRules({ ...rules, reentryMinutes: on ? WAIT_DEFAULT : null })}
      />
      {waiting ? (
        <FormField label="Wait">
          {(control) => (
            <NumberField
              {...control}
              unit="min"
              min={1}
              max={240}
              value={rules.reentryMinutes ?? null}
              onValueChange={(v) =>
                setRules({ ...rules, reentryMinutes: v ?? WAIT_DEFAULT }, 'access-wait')
              }
            />
          )}
        </FormField>
      ) : null}
      <PickEdit
        label="Suspend when"
        value={suspend?.input ?? NEVER}
        options={[
          { value: NEVER, label: 'Never' },
          ...inputs.map((i) => ({ value: i.name, label: i.label })),
        ]}
        help="A pass whose input holds one of these values is refused."
        onPick={(v) =>
          edit({
            op: 'access-suspend',
            suspend:
              v === NEVER
                ? undefined
                : {
                    input: v,
                    equals: inputs.find((i) => i.name === v)?.values.slice(-1) ?? ['Suspended'],
                  },
          })
        }
      />
      {suspend && chosen && chosen.values.length > 0 ? (
        <fieldset className="grid gap-1">
          <legend className="mb-1 text-sm font-medium text-fg-strong">Is</legend>
          {chosen.values.map((v) => (
            <CheckboxField
              key={v}
              label={v}
              checked={suspend.equals.includes(v)}
              onCheckedChange={(on) => {
                const equals =
                  on === true ? [...suspend.equals, v] : suspend.equals.filter((x) => x !== v);
                if (equals.length > 0)
                  edit({ op: 'access-suspend', suspend: { ...suspend, equals } });
              }}
            />
          ))}
        </fieldset>
      ) : suspend ? (
        <ValuesEdit
          value={suspend.equals}
          onCommit={(equals) => edit({ op: 'access-suspend', suspend: { ...suspend, equals } })}
        />
      ) : null}
    </div>
  );
}
