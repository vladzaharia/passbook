import { Lock, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, FieldGroup, FormField, FormGrid, FormSpan, Tooltip } from '../../../ui/index.ts';
import { Control } from './controls.tsx';
import { locationPairs } from './location.ts';
import { LocationInput } from './location-input.tsx';
import { describeSchema, type FormValues, validateValues } from './schema.ts';

export type FieldSources = Record<string, 'manual' | 'connection'>;

export interface SchemaFormProps {
  schema: unknown;
  value: FormValues;
  onChange: (next: FormValues) => void;
  /** Messages from the server, by field key. Shown regardless of touch state. */
  serverErrors?: Record<string, string> | undefined;
  /** Show every validation error, e.g. after a failed submit. */
  showAllErrors?: boolean;
  disabled?: boolean;
  idPrefix?: string;
  /** Fields a connection owns are read-only, with a "From <connection>" chip. */
  fieldSources?: FieldSources | undefined;
  /** The owning connection's name, for the chip. */
  sourceName?: string | undefined;
  onResetField?: ((key: string) => void) | undefined;
  /** Fields that are managed elsewhere and not rendered. */
  hiddenKeys?: ReadonlySet<string> | undefined;
  /** Max bytes for image widgets (stored as data URIs). */
  maxImageBytes?: number;
}

/** Form generated from a template input schema, in FieldGroups on a FormGrid. */
export function SchemaForm({
  schema,
  value,
  onChange,
  serverErrors,
  showAllErrors,
  disabled,
  idPrefix,
  fieldSources,
  sourceName,
  onResetField,
  hiddenKeys,
  maxImageBytes = 256 * 1024,
}: SchemaFormProps) {
  const groups = useMemo(
    () =>
      describeSchema(schema)
        .map((g) => ({ ...g, fields: g.fields.filter((f) => !hiddenKeys?.has(f.key)) }))
        .filter((g) => g.fields.length > 0),
    [schema, hiddenKeys],
  );
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  // A template's time zone input sets the zone its date-times are read and written in.
  const zoneKey = groups.flatMap((g) => g.fields).find((f) => f.widget === 'timezone')?.key;
  const zoneValue = zoneKey ? value[zoneKey] : undefined;
  const formZone = typeof zoneValue === 'string' && zoneValue ? zoneValue : undefined;
  const errors = useMemo(() => validateValues(schema, value), [schema, value]);

  if (groups.length === 0)
    return <p className="text-sm text-fg-muted">This template has no inputs.</p>;

  const patch = (changes: Record<string, unknown>) => {
    const next = { ...value };
    for (const [key, v] of Object.entries(changes)) {
      if (v === undefined || v === '') delete next[key];
      else next[key] = v;
    }
    onChange(next);
  };
  const touch = (key: string) => setTouched((t) => (t.has(key) ? t : new Set(t).add(key)));

  return (
    <div className="flex flex-col" data-prefix={idPrefix}>
      {groups.map((group) => {
        const pairs = locationPairs(group.fields);
        const paired = new Set(
          pairs.flatMap((p) => [p.lat.key, p.lng.key, ...(p.text ? [p.text.key] : [])]),
        );
        const visible = group.fields.filter((f) => !paired.has(f.key));
        const only = visible.length === 1 && pairs.length === 0 ? visible[0]?.label : undefined;
        return (
          <FieldGroup
            key={group.name || '_'}
            title={group.name || 'Details'}
            onlyFieldLabel={group.name ? only : 'Details'}
          >
            <FormGrid>
              {visible.map((field) => {
                const error =
                  serverErrors?.[field.key] ??
                  (showAllErrors || touched.has(field.key) ? errors[field.key] : undefined);
                const owned = fieldSources?.[field.key] === 'connection';
                const wide = WIDE.has(field.widget);
                return (
                  <FormSpan key={field.key} full={wide}>
                    <FormField
                      label={field.label}
                      help={
                        owned ? (
                          <SourceChip name={sourceName} />
                        ) : fieldSources?.[field.key] === 'manual' && onResetField ? (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0"
                            iconStart={<RotateCcw aria-hidden />}
                            disabled={disabled}
                            onClick={() => onResetField(field.key)}
                            aria-label={`Use the connection's value for ${field.label}`}
                          >
                            Use the connection's value
                          </Button>
                        ) : (
                          (field.help ??
                          (field.widget === 'textarea' ? 'Shown on the back.' : undefined))
                        )
                      }
                      error={error}
                      required={field.required}
                    >
                      {(control) => (
                        <Control
                          field={field}
                          value={value[field.key]}
                          onValue={(v) => patch({ [field.key]: v })}
                          onBlur={() => touch(field.key)}
                          control={control as unknown as Record<string, unknown>}
                          disabled={disabled || owned}
                          maxImageBytes={maxImageBytes}
                          zone={formZone}
                        />
                      )}
                    </FormField>
                  </FormSpan>
                );
              })}
              {pairs.map((pair) => (
                <LocationInput
                  key={pair.prefix}
                  pair={pair}
                  value={value}
                  onChange={patch}
                  disabled={disabled || fieldSources?.[pair.lat.key] === 'connection'}
                  serverError={serverErrors?.[pair.lat.key] ?? serverErrors?.[pair.lng.key]}
                />
              ))}
            </FormGrid>
          </FieldGroup>
        );
      })}
    </div>
  );
}

const WIDE = new Set(['textarea', 'image', 'datetime', 'url']);

/** "From MemberSpot sync": the connection owns this field; edit it in the source. */
function SourceChip({ name }: { name?: string | undefined }) {
  return (
    <Tooltip content="Edit in the source">
      {/* A button so keyboard users reach the tooltip; it does nothing on press. */}
      <button
        type="button"
        className="inline-flex cursor-default items-center gap-1 rounded-sm text-info focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Lock aria-hidden className="size-3.5" />
        From {name ?? 'the connection'}
      </button>
    </Tooltip>
  );
}
