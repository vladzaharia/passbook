import { Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { VoidRule } from '@/shared/contracts/connections.ts';
import { Button, FormField, IconButton, Input, Select } from '../../ui/index.ts';

export const MAX_VOID_RULES = 8;

/** "gold, true, 3" to values; true, false and numbers keep their type, which `in` compares strictly. */
function parseValues(text: string): NonNullable<VoidRule['values']> {
  return text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) =>
      t === 'true' ? true : t === 'false' ? false : /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : t,
    );
}

/** Rows that cannot be saved yet. */
export function voidWhenError(rules: readonly VoidRule[]): string | undefined {
  return rules.some((r) => !r.from.startsWith('/') || (r.op === 'in' && !r.values?.length))
    ? 'Finish or remove the void rules.'
    : undefined;
}

function Row({
  rule,
  disabled,
  onChange,
  onRemove,
}: {
  rule: VoidRule;
  disabled?: boolean | undefined;
  onChange: (next: VoidRule) => void;
  onRemove: () => void;
}) {
  const [text, setText] = useState((rule.values ?? []).join(', '));
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
      <FormField label="Field" className="min-w-0 flex-[1_1_9rem]">
        {(c) => (
          <Input
            {...c}
            className="font-mono"
            placeholder="/status"
            spellCheck={false}
            autoCapitalize="off"
            disabled={disabled}
            value={rule.from}
            onChange={(e) => onChange({ ...rule, from: e.target.value })}
          />
        )}
      </FormField>
      <FormField label="Test" className="flex-[0_1_9rem]">
        {(c) => (
          <Select
            {...c}
            disabled={disabled}
            value={rule.op}
            options={[
              { value: 'in', label: 'is one of' },
              { value: 'present', label: 'is set' },
            ]}
            onValueChange={(op) =>
              onChange(
                op === 'present'
                  ? { from: rule.from, op: 'present' }
                  : { from: rule.from, op: 'in', values: parseValues(text) },
              )
            }
          />
        )}
      </FormField>
      {rule.op === 'in' ? (
        <FormField label="Values" className="min-w-0 flex-[2_1_14rem]">
          {(c) => (
            <Input
              {...c}
              className="font-mono"
              placeholder="canceled, refunded"
              spellCheck={false}
              disabled={disabled}
              value={text}
              onChange={(e) => {
                setText(e.target.value);
                onChange({ ...rule, values: parseValues(e.target.value) });
              }}
            />
          )}
        </FormField>
      ) : null}
      <IconButton
        label="Remove void rule"
        icon={<X aria-hidden />}
        disabled={disabled}
        onClick={onRemove}
      />
    </div>
  );
}

/** Voids the bound pass when its record matches any rule. A voided pass stays voided. */
export function VoidWhenFields({
  value,
  onChange,
  disabled,
}: {
  value: readonly VoidRule[];
  onChange: (next: VoidRule[]) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-3">
      <legend className="mb-1 text-sm font-medium text-fg">Void when</legend>
      {value.map((rule, i) => (
        <Row
          // Rows have no identity beyond their place.
          // biome-ignore lint/suspicious/noArrayIndexKey: edited in place
          key={i}
          rule={rule}
          disabled={disabled}
          onChange={(next) => onChange(value.map((r, j) => (j === i ? next : r)))}
          onRemove={() => onChange(value.filter((_, j) => j !== i))}
        />
      ))}
      <p className="text-xs text-fg-muted">Voided passes stay voided.</p>
      {value.length < MAX_VOID_RULES ? (
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={disabled}
            onClick={() => onChange([...value, { from: '', op: 'in', values: [] }])}
          >
            <Plus aria-hidden /> Add rule
          </Button>
        </div>
      ) : null}
    </fieldset>
  );
}
