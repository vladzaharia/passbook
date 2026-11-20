import type { EntitlementKey, EntitlementValue } from '@/shared/contracts/entitlements.ts';
import { entitlementDef, parseEntitlementValue } from '@/shared/contracts/entitlements.ts';
import { ENTITLEMENT_LEVEL_LABEL } from '@/shared/copy/entitlements.ts';
import {
  CheckboxField,
  type FieldControlProps,
  FormField,
  NumberField,
  SegmentedControl,
  Select,
  Textarea,
} from '@/web/ui/index.ts';

/** What the form holds for a value before it is read as one: text for a list, text and a switch for a limit. */
export interface ValueDraft {
  flag: '0' | '1';
  level: string;
  limit: number | null;
  unlimited: boolean;
  list: string;
}

export function draftOf(key: EntitlementKey, value: EntitlementValue): ValueDraft {
  const def = entitlementDef(key);
  return {
    flag: value === 1 ? '1' : '0',
    level: typeof value === 'string' ? value : def.kind === 'level' ? (def.levels[0] ?? '') : '',
    limit: typeof value === 'number' ? value : null,
    unlimited: value === null,
    list: Array.isArray(value) ? value.join('\n') : '',
  };
}

const LIMIT_ERROR = 'Enter a whole number, 0 or more.';

/** The value the draft means, or the sentence that says why it is not one. */
export function valueFromDraft(
  key: EntitlementKey,
  d: ValueDraft,
): { value: EntitlementValue } | { error: string } {
  const def = entitlementDef(key);
  let raw: unknown;
  if (def.kind === 'flag') raw = d.flag === '1' ? 1 : 0;
  else if (def.kind === 'level') raw = d.level;
  else if (def.kind === 'limit') {
    // An empty field is not "no limit": that is the box below it.
    if (!d.unlimited && d.limit === null) return { error: LIMIT_ERROR };
    raw = d.unlimited ? null : d.limit;
  } else
    raw = d.list
      .split(/[\n,]/)
      .map((e) => e.trim())
      .filter(Boolean);
  const value = parseEntitlementValue(key, raw);
  if (value !== undefined) return { value };
  if (def.kind === 'limit') return { error: LIMIT_ERROR };
  if (def.kind === 'list') return { error: 'Use entries like csv-url, shopify/* or *.' };
  return { error: 'Choose a value.' };
}

/** The control for the feature's kind. */
export function ValueField({
  featureKey,
  draft,
  onChange,
  error,
}: {
  featureKey: EntitlementKey;
  draft: ValueDraft;
  onChange: (next: ValueDraft) => void;
  error?: string | undefined;
}) {
  const def = entitlementDef(featureKey);
  const set = (patch: Partial<ValueDraft>) => onChange({ ...draft, ...patch });
  if (def.kind === 'flag')
    return (
      <div className="flex flex-col gap-2">
        <span className="text-sm font-medium text-fg">Value</span>
        <SegmentedControl
          label="Value"
          value={draft.flag}
          onValueChange={(flag) => set({ flag })}
          options={[
            { value: '1', label: 'On' },
            { value: '0', label: 'Off' },
          ]}
        />
      </div>
    );
  if (def.kind === 'level')
    return (
      <FormField label="Value">
        {(p) => (
          <Select
            {...selectProps(p)}
            value={draft.level}
            onValueChange={(level) => set({ level })}
            options={def.levels.map((l) => ({
              value: l,
              label: ENTITLEMENT_LEVEL_LABEL[featureKey]?.[l] ?? l,
            }))}
          />
        )}
      </FormField>
    );
  if (def.kind === 'limit')
    return (
      <div className="flex flex-col gap-2">
        <FormField
          label="Limit"
          error={error}
          help={draft.unlimited ? undefined : '0 turns it off.'}
        >
          {(p) =>
            draft.unlimited ? (
              <p id={p.id} className="text-sm text-fg-muted">
                No limit
              </p>
            ) : (
              <NumberField
                {...p}
                min={0}
                step={1}
                value={draft.limit}
                onValueChange={(limit) => set({ limit })}
              />
            )
          }
        </FormField>
        <CheckboxField
          label="No limit"
          checked={draft.unlimited}
          onCheckedChange={(on) => set({ unlimited: on === true })}
        />
      </div>
    );
  return (
    <FormField
      label={def.block ? 'Blocked' : 'Allowed'}
      error={error}
      help="One per line or comma-separated. * means all."
    >
      {(p) => (
        <Textarea
          {...p}
          rows={4}
          className="font-mono"
          autoCapitalize="off"
          spellCheck={false}
          value={draft.list}
          onChange={(e) => set({ list: e.target.value })}
        />
      )}
    </FormField>
  );
}

const selectProps = (p: FieldControlProps) => ({
  id: p.id,
  'aria-describedby': p['aria-describedby'],
  ...(p['aria-invalid'] ? { 'aria-invalid': true } : {}),
});
