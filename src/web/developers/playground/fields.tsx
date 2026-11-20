import { useId } from 'react';
import type { InputProp, InputSchema, InputValues } from './model.ts';

interface Row {
  name: string;
  prop: InputProp;
  required: boolean;
}

/** The schema's fields in the order its author gave them, with the group each belongs to. */
export function rowsOf(schema: InputSchema): { group: string; rows: Row[] }[] {
  const required = new Set(schema.required ?? []);
  const rows = Object.entries(schema.properties ?? {})
    .map(([name, prop], i) => ({ name, prop, required: required.has(name), i }))
    .sort((a, b) => (a.prop['x-order'] ?? 1e6) - (b.prop['x-order'] ?? 1e6) || a.i - b.i);
  const groups: { group: string; rows: Row[] }[] = [];
  for (const row of rows) {
    const group = row.prop['x-group'] ?? '';
    const at = groups.find((g) => g.group === group);
    if (at) at.rows.push(row);
    else groups.push({ group, rows: [row] });
  }
  return groups;
}

const labelOf = (name: string, prop: InputProp) =>
  prop['x-label'] ?? name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

const show = (v: unknown): string =>
  v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);

function Control({
  id,
  prop,
  value,
  onChange,
}: {
  id: string;
  prop: InputProp;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  if (prop.type === 'array' || prop.type === 'object' || (prop as { items?: unknown }).items)
    return (
      <span className="input ro" id={id}>
        {Array.isArray(value)
          ? `${value.length} ${value.length === 1 ? 'item' : 'items'}`
          : 'Object'}
        <span className="push xs muted">Edit in JSON</span>
      </span>
    );
  if (prop.enum)
    return (
      <select
        id={id}
        className="input sel"
        value={show(value)}
        onChange={(e) => onChange(e.target.value)}
      >
        {prop.enum.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  if (prop.type === 'boolean')
    return (
      <label className="input check">
        <input
          id={id}
          type="checkbox"
          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{value === true ? 'Yes' : 'No'}</span>
      </label>
    );
  const numeric = prop.type === 'integer' || prop.type === 'number';
  return (
    <input
      id={id}
      className="input"
      type={numeric ? 'number' : 'text'}
      {...(numeric
        ? { step: prop.type === 'integer' ? 1 : 'any', inputMode: 'decimal' as const }
        : {})}
      value={show(value)}
      {...(prop.maxLength ? { maxLength: prop.maxLength } : {})}
      placeholder={prop.format === 'date-time' ? '2030-06-01T19:00:00-07:00' : undefined}
      spellCheck={false}
      autoComplete="off"
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === '') return onChange(null);
        onChange(numeric ? Number(raw) : raw);
      }}
    />
  );
}

function FieldRow({
  row,
  value,
  was,
  changed,
  onChange,
}: {
  row: Row;
  value: unknown;
  was: unknown;
  changed: boolean;
  onChange: (value: unknown) => void;
}) {
  const id = useId();
  return (
    <div className="field" data-changed={changed || undefined}>
      <label htmlFor={id}>
        {labelOf(row.name, row.prop)}
        {row.required ? <span className="bad-t"> *</span> : null}
      </label>
      <div className="ctl">
        <Control id={id} prop={row.prop} value={value} onChange={onChange} />
        {changed ? (
          <span className="was xs muted">
            {was === undefined ? 'was empty' : `was ${show(was).slice(0, 24)}`}
          </span>
        ) : null}
      </div>
      {row.prop.format === 'date-time' ? (
        <span className="help">ISO 8601, with the offset.</span>
      ) : null}
    </div>
  );
}

export function Fields({
  schema,
  values,
  sample,
  onChange,
}: {
  schema: InputSchema;
  values: InputValues;
  sample: InputValues;
  onChange: (name: string, value: unknown) => void;
}) {
  const groups = rowsOf(schema);
  return (
    <>
      {groups.map(({ group, rows }) => (
        <fieldset key={group} className="grp">
          {group && groups.length > 1 ? <legend>{group}</legend> : null}
          {rows.map((row) => (
            <FieldRow
              key={row.name}
              row={row}
              value={values[row.name]}
              was={sample[row.name]}
              changed={
                JSON.stringify(values[row.name] ?? null) !==
                JSON.stringify(sample[row.name] ?? null)
              }
              onChange={(v) => onChange(row.name, v)}
            />
          ))}
        </fieldset>
      ))}
    </>
  );
}
