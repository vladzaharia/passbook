import { useId, useState } from 'react';
import { type Draft, parseBody } from '../request.ts';
import type { Json, RunOp, RunParam, RunSchema } from '../types.ts';
import type { Issue } from '../validate.ts';

interface FieldProps {
  name: string;
  schema: RunSchema;
  required: boolean;
  value: Json | undefined;
  error: string | undefined;
  onChange: (v: Json | undefined) => void;
}

const typeOf = (s: RunSchema) =>
  Array.isArray(s.type) ? s.type.find((t) => t !== 'null') : s.type;

function hint(s: RunSchema): string {
  if (s.enum) return s.enum.map((e) => JSON.stringify(e)).join(' | ');
  const bits = [s.format ?? typeOf(s) ?? 'any'];
  if (s.maxLength !== undefined) bits.push(`max ${s.maxLength}`);
  if (s.minimum !== undefined) bits.push(`≥ ${s.minimum}`);
  return bits.join(' · ');
}

/** An object or array field: compact JSON text, kept as typed until it parses. */
function JsonField({
  value,
  id,
  invalid,
  onChange,
}: {
  value: Json | undefined;
  id: string;
  invalid: boolean;
  onChange: FieldProps['onChange'];
}) {
  const [text, setText] = useState(value === undefined ? '' : JSON.stringify(value));
  const [bad, setBad] = useState(false);
  return (
    <textarea
      id={id}
      className="ctl mono"
      rows={2}
      spellCheck={false}
      value={text}
      aria-invalid={invalid || bad}
      onChange={(e) => {
        setText(e.target.value);
        const parsed = parseBody(e.target.value);
        setBad(!parsed.ok);
        if (parsed.ok) onChange(parsed.value);
      }}
    />
  );
}

export function Field({ name, schema, required, value, error, onChange }: FieldProps) {
  const uid = useId();
  const id = `${uid}-${name}`;
  const t = typeOf(schema);
  const invalid = error !== undefined;
  let control: React.ReactNode;
  if (schema.enum) {
    control = (
      <select
        id={id}
        className="ctl"
        value={value === undefined ? '' : JSON.stringify(value)}
        aria-invalid={invalid}
        onChange={(e) =>
          onChange(e.target.value === '' ? undefined : (JSON.parse(e.target.value) as Json))
        }
      >
        <option value="">—</option>
        {schema.enum.map((e) => (
          <option key={JSON.stringify(e)} value={JSON.stringify(e)}>
            {String(e)}
          </option>
        ))}
      </select>
    );
  } else if (t === 'boolean') {
    control = (
      <select
        id={id}
        className="ctl"
        value={value === undefined ? '' : String(value)}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value === '' ? undefined : e.target.value === 'true')}
      >
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  } else if (t === 'object' || t === 'array') {
    control = <JsonField id={id} value={value} invalid={invalid} onChange={onChange} />;
  } else {
    const num = t === 'integer' || t === 'number';
    control = (
      <input
        id={id}
        type={num ? 'number' : 'text'}
        inputMode={num ? 'decimal' : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={invalid}
        value={value === undefined || value === null ? '' : String(value)}
        onChange={(e) => {
          const raw = e.target.value;
          onChange(raw === '' ? undefined : num && !Number.isNaN(Number(raw)) ? Number(raw) : raw);
        }}
      />
    );
  }
  return (
    <div className="fld">
      <label htmlFor={id} className="fld-l">
        <span className="pn">{name}</span>
        <span className="pt">{hint(schema)}</span>
        {required ? <span className="req">Required</span> : null}
      </label>
      {control}
      {schema.description ? <span className="fld-d">{schema.description}</span> : null}
      {error ? <span className="fld-e">{error}</span> : null}
    </div>
  );
}

const WHERE = { path: 'Path', query: 'Query' } as const;

function ParamFields({
  op,
  where,
  draft,
  issues,
  set,
}: {
  op: RunOp;
  where: 'path' | 'query';
  draft: Draft;
  issues: Issue[];
  set: (next: Draft) => void;
}) {
  const rows = op.params.filter((p: RunParam) => p.where === where);
  if (rows.length === 0) return null;
  return (
    <fieldset className="fset">
      <legend>{WHERE[where]}</legend>
      {rows.map((p) => (
        <Field
          key={p.name}
          name={p.name}
          schema={p.schema}
          required={p.required}
          value={
            draft[where][p.name] === undefined || draft[where][p.name] === ''
              ? undefined
              : (draft[where][p.name] as string)
          }
          error={issues.find((i) => i.path === p.name)?.message}
          onChange={(v) =>
            set({
              ...draft,
              [where]: { ...draft[where], [p.name]: v === undefined ? '' : String(v) },
            })
          }
        />
      ))}
    </fieldset>
  );
}

/** The request as inputs, built from the schema. Body edits rewrite the JSON; the JSON tab shows the same text. */
export function FormTab({
  op,
  draft,
  issues,
  set,
}: {
  op: RunOp;
  draft: Draft;
  issues: Issue[];
  set: (next: Draft) => void;
}) {
  const parsed = parseBody(draft.body);
  const obj =
    parsed.ok && parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value)
      ? (parsed.value as Record<string, Json>)
      : null;
  const props = Object.entries(op.body?.properties ?? {});
  const required = new Set(op.body?.required ?? []);
  props.sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));
  const edit = (key: string, v: Json | undefined) => {
    const next = { ...(obj ?? {}) };
    if (v === undefined) delete next[key];
    else next[key] = v;
    set({ ...draft, body: JSON.stringify(next, null, 2) });
  };
  const empty = op.params.length === 0 && !op.body;
  return (
    <div className="form">
      {empty ? <p className="muted sm">This call takes no parameters.</p> : null}
      <ParamFields op={op} where="path" draft={draft} issues={issues} set={set} />
      <ParamFields op={op} where="query" draft={draft} issues={issues} set={set} />
      {op.body ? (
        <fieldset className="fset">
          <legend>Body</legend>
          {obj === null && draft.body.trim() !== '' ? (
            <p className="muted sm">Fix the JSON first. The form needs an object.</p>
          ) : props.length === 0 ? (
            <p className="muted sm">Edit this body in the JSON tab.</p>
          ) : (
            props.map(([k, s]) => (
              <Field
                key={k}
                name={k}
                schema={s}
                required={required.has(k)}
                value={obj?.[k]}
                error={
                  issues.find(
                    (i) => i.path === k || i.path.startsWith(`${k}.`) || i.path.startsWith(`${k}[`),
                  )?.message
                }
                onChange={(v) => edit(k, v)}
              />
            ))
          )}
        </fieldset>
      ) : null}
    </div>
  );
}
