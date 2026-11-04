import { Lock, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { cn } from '../../../lib/cn.ts';
import { useInCard } from '../../../ui/in-card.ts';
import {
  Button,
  Card,
  CardBody,
  CardHeader,
  FieldGroup,
  FormField,
  FormGrid,
  FormSpan,
  Tooltip,
} from '../../../ui/index.ts';
import { Control, WIDE_WIDGETS } from './controls.tsx';
import { ListInput } from './list-input.tsx';
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

/**
 * Form generated from a template input schema, one section per group: a Card with its CardHeader
 * on a page (the org detail pattern), a FieldGroup heading when it already sits in a card.
 */
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
  const inCard = useInCard();
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  // A template's time zone input sets the zone its date-times are read and written in.
  const zoneKey = groups.flatMap((g) => g.fields).find((f) => f.widget === 'timezone')?.key;
  const zoneValue = zoneKey ? value[zoneKey] : undefined;
  const formZone = typeof zoneValue === 'string' && zoneValue ? zoneValue : undefined;
  const errors = useMemo(() => validateValues(schema, value), [schema, value]);
  // The server names a list row's field `events/0/name`; rows here use dots.
  const server = useMemo(
    () =>
      serverErrors
        ? Object.fromEntries(
            Object.entries(serverErrors).map(([k, v]) => [k.replace(/\//g, '.'), v]),
          )
        : undefined,
    [serverErrors],
  );

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
    <div className={cn('flex flex-col', !inCard && 'gap-6')} data-prefix={idPrefix}>
      {groups.map((group) => {
        const pairs = locationPairs(group.fields);
        const paired = new Set(
          pairs.flatMap((p) => [p.lat.key, p.lng.key, ...(p.text ? [p.text.key] : [])]),
        );
        const visible = group.fields.filter((f) => !paired.has(f.key));
        const only = visible.length === 1 && pairs.length === 0 ? visible[0]?.label : undefined;
        const title = group.name || 'Details';
        const grid = (
          <FormGrid>
            {visible.map((field) => {
              const error =
                server?.[field.key] ??
                (showAllErrors || touched.has(field.key) ? errors[field.key] : undefined);
              const owned = fieldSources?.[field.key] === 'connection';
              const wide = WIDE_WIDGETS.has(field.widget);
              if (field.widget === 'list')
                return (
                  <FormSpan key={field.key} full>
                    <ListInput
                      field={field}
                      value={value[field.key]}
                      onValue={(rows) => patch({ [field.key]: rows })}
                      errors={errors}
                      serverErrors={server}
                      showAllErrors={showAllErrors || touched.has(field.key)}
                      disabled={disabled || owned}
                      maxImageBytes={maxImageBytes}
                      zone={formZone}
                    />
                  </FormSpan>
                );
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
                serverError={server?.[pair.lat.key] ?? server?.[pair.lng.key]}
              />
            ))}
          </FormGrid>
        );
        if (inCard)
          return (
            <FieldGroup
              key={group.name || '_'}
              title={title}
              onlyFieldLabel={group.name ? only : 'Details'}
            >
              {grid}
            </FieldGroup>
          );
        // A heading that would repeat the only field's label, or name ungrouped fields, is left out.
        const heading = group.name && group.name.trim() !== only?.trim();
        return (
          <Card
            key={group.name || '_'}
            role={heading ? 'region' : undefined}
            aria-label={heading ? title : undefined}
          >
            {heading ? <CardHeader title={title} /> : null}
            <CardBody>{grid}</CardBody>
          </Card>
        );
      })}
    </div>
  );
}

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
