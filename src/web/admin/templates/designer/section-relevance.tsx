import { Plus, Trash2 } from 'lucide-react';
import { Button, FormField, IconButton, Input } from '../../../ui/index.ts';
import { useDesigner } from './context.tsx';
import type { Dict } from './model.ts';
import { type ListKey, listOf } from './ops-more.ts';

type Column = { key: string; label: string; kind: 'text' | 'number' | 'date'; help?: string };

const isoToLocal = (iso: unknown): string => {
  const d = typeof iso === 'string' ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};
const localToIso = (local: string): string | undefined => {
  const d = new Date(local);
  return local && !Number.isNaN(d.getTime()) ? d.toISOString() : undefined;
};

function ListEditor({
  list,
  title,
  columns,
  blank,
}: {
  list: ListKey;
  title: string;
  columns: Column[];
  blank: Dict;
}) {
  const { doc, edit } = useDesigner();
  const items = listOf(doc, list);
  const write = (next: Dict[], merge?: string) =>
    edit({ op: 'list', key: list, items: next }, merge);
  const change = (i: number, col: Column, raw: string) => {
    const value =
      raw === ''
        ? undefined
        : col.kind === 'number'
          ? Number(raw)
          : col.kind === 'date'
            ? localToIso(raw)
            : raw;
    write(
      items.map((item, j) => {
        if (j !== i) return item;
        const copy = { ...item };
        if (value === undefined || (typeof value === 'number' && Number.isNaN(value)))
          delete copy[col.key];
        else copy[col.key] = value;
        return copy;
      }),
      `${list}:${i}:${col.key}`,
    );
  };
  return (
    <section
      aria-label={title}
      className="grid gap-3"
      data-target={`relevance:${list}`}
      tabIndex={-1}
    >
      <h3 className="text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</h3>
      <ul className="grid gap-2">
        {items.map((item, i) => (
          // The list is edited in place; position is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
          <li key={i} className="dz-row p-3" data-new={undefined}>
            <div className="grid gap-3 sm:grid-cols-2">
              {columns.map((col) => (
                <FormField key={col.key} label={col.label} help={col.help}>
                  {(control) => (
                    <Input
                      {...control}
                      type={
                        col.kind === 'number'
                          ? 'number'
                          : col.kind === 'date'
                            ? 'datetime-local'
                            : 'text'
                      }
                      step={col.kind === 'number' ? 'any' : undefined}
                      value={
                        col.kind === 'date'
                          ? isoToLocal(item[col.key])
                          : String(item[col.key] ?? '')
                      }
                      onChange={(e) => change(i, col, e.target.value)}
                    />
                  )}
                </FormField>
              ))}
            </div>
            <IconButton
              label={`Remove ${title.toLowerCase()} ${i + 1}`}
              icon={<Trash2 aria-hidden />}
              variant="ghost"
              size="sm"
              className="mt-2"
              onClick={() => write(items.filter((_, j) => j !== i))}
            />
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        className="justify-self-start"
        iconStart={<Plus aria-hidden />}
        onClick={() => write([...items, blank])}
      >
        Add
      </Button>
    </section>
  );
}

export function RelevanceSection() {
  const { doc, edit } = useDesigner();
  const expiry = typeof doc.passJson.expirationDate === 'string' ? doc.passJson.expirationDate : '';
  return (
    <div className="grid gap-6">
      <ListEditor
        list="locations"
        title="Locations"
        blank={{ latitude: 0, longitude: 0 }}
        columns={[
          { key: 'latitude', label: 'Latitude', kind: 'number' },
          { key: 'longitude', label: 'Longitude', kind: 'number' },
          { key: 'relevantText', label: 'Lock screen text', kind: 'text' },
          {
            key: 'maxDistance',
            label: 'Distance (m)',
            kind: 'number',
            help: 'Can only shrink the default.',
          },
        ]}
      />
      <ListEditor
        list="beacons"
        title="Beacons"
        blank={{ proximityUUID: '' }}
        columns={[
          { key: 'proximityUUID', label: 'UUID', kind: 'text' },
          { key: 'major', label: 'Major', kind: 'number' },
          { key: 'minor', label: 'Minor', kind: 'number' },
          { key: 'relevantText', label: 'Lock screen text', kind: 'text' },
        ]}
      />
      <ListEditor
        list="relevantDates"
        title="Relevant dates"
        blank={{
          startDate: new Date(Date.now() + 86_400_000).toISOString(),
          endDate: new Date(Date.now() + 93_600_000).toISOString(),
        }}
        columns={[
          { key: 'startDate', label: 'Starts', kind: 'date' },
          { key: 'endDate', label: 'Ends', kind: 'date' },
        ]}
      />
      <FormField label="Expires">
        {(control) => (
          <Input
            {...control}
            type="datetime-local"
            value={isoToLocal(expiry)}
            onChange={(e) =>
              edit(
                { op: 'pass-prop', key: 'expirationDate', value: localToIso(e.target.value) },
                'expires',
              )
            }
          />
        )}
      </FormField>
    </div>
  );
}
