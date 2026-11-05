import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, FormField, IconButton, Input } from '../../../ui/index.ts';
import { DateTimeInput } from '../../passes/schema-form/datetime-input.tsx';
import { useDesigner } from './context.tsx';
import type { Dict } from './model.ts';
import { type ListKey, listOf } from './ops-more.ts';

type Column = {
  key: string;
  label: string;
  kind: 'text' | 'number' | 'date' | 'uuid';
  help?: string;
};

/** The server accepts at most this many of each (validate-relevance). */
const MAX_ROWS = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function problemOf(col: Column, value: unknown): string | undefined {
  if (col.kind === 'uuid' && typeof value === 'string' && value !== '' && !UUID.test(value))
    return 'Use a UUID like 3F2A9B1C-4D5E-4F60-8A7B-9C0D1E2F3A4B.';
  return undefined;
}

function ListEditor({
  list,
  title,
  noun,
  columns,
}: {
  list: ListKey;
  title: string;
  noun: string;
  columns: Column[];
}) {
  const { doc, edit } = useDesigner();
  const items = listOf(doc, list);
  const [fresh, setFresh] = useState<number | null>(null);
  const write = (next: Dict[], merge?: string) =>
    edit({ op: 'list', key: list, items: next }, merge);
  const set = (i: number, col: Column, value: unknown) =>
    write(
      items.map((item, j) => {
        if (j !== i) return item;
        const copy = { ...item };
        if (
          value === undefined ||
          value === '' ||
          (typeof value === 'number' && Number.isNaN(value))
        )
          delete copy[col.key];
        else copy[col.key] = value;
        return copy;
      }),
      `${list}:${i}:${col.key}`,
    );
  const move = (i: number, to: number) => {
    const next = [...items];
    const [row] = next.splice(i, 1);
    next.splice(to, 0, row as Dict);
    write(next);
  };
  const full = items.length >= MAX_ROWS;
  return (
    <section
      aria-label={title}
      className="grid gap-3"
      data-target={`relevance:${list}`}
      tabIndex={-1}
    >
      <h3 className="text-sm font-semibold text-fg-strong">{title}</h3>
      <ul className="grid gap-2">
        {items.map((item, i) => (
          // The list is edited in place; position is its identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
          <li key={i} className="dz-row @container p-3" data-new={fresh === i ? '' : undefined}>
            <div className="mb-2 flex items-center justify-between gap-2">
              <h4 className="text-xs font-medium text-fg-muted">
                {noun} {i + 1}
              </h4>
              <div className="flex items-center gap-1">
                <IconButton
                  label={`Move ${noun.toLowerCase()} ${i + 1} up`}
                  icon={<ArrowUp aria-hidden />}
                  size="sm"
                  disabled={i === 0}
                  onClick={() => move(i, i - 1)}
                />
                <IconButton
                  label={`Move ${noun.toLowerCase()} ${i + 1} down`}
                  icon={<ArrowDown aria-hidden />}
                  size="sm"
                  disabled={i === items.length - 1}
                  onClick={() => move(i, i + 1)}
                />
                <IconButton
                  label={`Remove ${noun.toLowerCase()} ${i + 1}`}
                  icon={<Trash2 aria-hidden />}
                  size="sm"
                  onClick={() => write(items.filter((_, j) => j !== i))}
                />
              </div>
            </div>
            <div className="grid gap-3 @md:grid-cols-2">
              {columns.map((col) => (
                <div key={col.key} className={col.kind === 'uuid' ? '@md:col-span-2' : undefined}>
                  <FormField
                    label={col.label}
                    help={col.help}
                    error={problemOf(col, item[col.key])}
                  >
                    {(control) =>
                      col.kind === 'date' ? (
                        <DateTimeInput
                          {...control}
                          value={typeof item[col.key] === 'string' ? (item[col.key] as string) : ''}
                          onValue={(v) => set(i, col, v)}
                          onBlur={() => undefined}
                        />
                      ) : (
                        <Input
                          {...control}
                          className={col.kind === 'uuid' ? 'font-mono' : undefined}
                          type={col.kind === 'number' ? 'number' : 'text'}
                          step={col.kind === 'number' ? 'any' : undefined}
                          value={String(item[col.key] ?? '')}
                          onChange={(e) =>
                            set(
                              i,
                              col,
                              col.kind === 'number' && e.target.value !== ''
                                ? Number(e.target.value)
                                : e.target.value,
                            )
                          }
                        />
                      )
                    }
                  </FormField>
                </div>
              ))}
            </div>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={full}
          iconStart={<Plus aria-hidden />}
          onClick={() => {
            setFresh(items.length);
            write([...items, {}]);
          }}
        >
          Add {noun.toLowerCase()}
        </Button>
        {full ? (
          <span className="text-xs text-fg-muted">
            At most {MAX_ROWS} {title.toLowerCase()}.
          </span>
        ) : null}
      </div>
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
        noun="Location"
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
        noun="Beacon"
        columns={[
          { key: 'proximityUUID', label: 'UUID', kind: 'uuid' },
          { key: 'major', label: 'Major', kind: 'number' },
          { key: 'minor', label: 'Minor', kind: 'number' },
          { key: 'relevantText', label: 'Lock screen text', kind: 'text' },
        ]}
      />
      <ListEditor
        list="relevantDates"
        title="Relevant dates"
        noun="Date"
        columns={[
          { key: 'startDate', label: 'Starts', kind: 'date' },
          { key: 'endDate', label: 'Ends', kind: 'date' },
        ]}
      />
      <section aria-label="Expiry" className="grid gap-3">
        <h3 className="text-sm font-semibold text-fg-strong">Expiry</h3>
        <FormField label="Expires">
          {(control) => (
            <DateTimeInput
              {...control}
              value={expiry}
              clearLabel="Never expires"
              onValue={(v) => edit({ op: 'pass-prop', key: 'expirationDate', value: v }, 'expires')}
              onBlur={() => undefined}
            />
          )}
        </FormField>
      </section>
    </div>
  );
}
