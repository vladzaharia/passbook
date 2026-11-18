import { X } from 'lucide-react';
import { Badge, Combobox, Select } from '../../../ui/index.ts';
import { useZones } from '../../scanning/zones-query.ts';
import type { FieldDef } from '../schema-form/schema.ts';

const NONE = '__none__';

/**
 * Zones a pass may enter on top of its plan: a list of keys, or one key when the input is text
 * (a home club). Names come from the organization's zones; without zone access a key shows as is.
 */
export function AccessZonesInput({
  field,
  value,
  onValue,
  disabled,
  control,
}: {
  field: FieldDef;
  value: unknown;
  onValue: (v: string[] | string | undefined) => void;
  disabled?: boolean | undefined;
  control: Record<string, unknown>;
}) {
  const zones = useZones();
  const list = zones.data?.items ?? [];
  const name = (key: string) => list.find((z) => z.key === key)?.name ?? key;
  const options = list.map((z) => ({
    value: z.key,
    label: `${'  '.repeat(z.depth)}${z.name}`,
  }));
  const id = control.id as string | undefined;
  const described = control['aria-describedby'] as string | undefined;
  if (field.type !== 'array') {
    const one = typeof value === 'string' ? value : '';
    return (
      <Select
        id={id}
        aria-describedby={described}
        disabled={disabled === true || !zones.isSuccess}
        value={one || NONE}
        placeholder={zones.isError ? 'Zones unavailable' : 'Loading zones'}
        options={[{ value: NONE, label: 'None' }, ...options]}
        onValueChange={(v) => onValue(v === NONE ? undefined : v)}
      />
    );
  }
  const keys = Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  const free = options.filter((o) => !keys.includes(o.value));
  return (
    <div className="grid gap-2">
      {keys.length > 0 ? (
        <ul aria-label={`${field.label} chosen`} className="flex flex-wrap gap-1.5">
          {keys.map((key) => (
            <li key={key}>
              <Badge tone="accent" className="min-h-8 gap-1.5 pr-1 pointer-coarse:min-h-11">
                {name(key)}
                <button
                  type="button"
                  aria-label={`Remove ${name(key)}`}
                  disabled={disabled}
                  className="inline-flex size-6 items-center justify-center rounded-full hover:bg-state-hover-tint focus-visible:outline-2 focus-visible:outline-focus pointer-coarse:size-9"
                  onClick={() => {
                    const rest = keys.filter((k) => k !== key);
                    onValue(rest.length > 0 ? rest : undefined);
                  }}
                >
                  <X aria-hidden />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      ) : null}
      <Combobox
        id={id}
        aria-describedby={described}
        aria-label={field.label}
        disabled={disabled === true || !zones.isSuccess}
        placeholder={
          zones.isError ? 'Zones unavailable' : zones.isPending ? 'Loading zones' : 'Add a zone'
        }
        searchPlaceholder="Find a zone"
        emptyText="No more zones"
        options={free}
        value={undefined}
        onValueChange={(v) => onValue([...keys, v])}
      />
    </div>
  );
}
