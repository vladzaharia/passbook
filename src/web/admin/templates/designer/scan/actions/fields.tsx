import { useState } from 'react';
import type { ValidationIssue } from '@/passkit/types.ts';
import { FormField, Input, NumberField } from '../../../../../ui/index.ts';
import type { Op } from '../../apply.ts';
import { useDesigner } from '../../context.tsx';

/** A number through the history; empty removes the setting. */
export function NumEdit({
  label,
  value,
  op,
  merge,
  unit,
  help,
  error,
  min,
  step,
}: {
  label: string;
  value: number | undefined;
  op: (value: number | null) => Op;
  merge: string;
  unit?: string;
  help?: string;
  error?: string | undefined;
  min?: number;
  step?: number | 'any';
}) {
  const { edit, readOnly } = useDesigner();
  return (
    <FormField label={label} help={help} error={error}>
      {(control) => (
        <NumberField
          {...control}
          value={value}
          unit={unit}
          min={min}
          step={step ?? 'any'}
          readOnly={readOnly}
          className="w-36"
          onValueChange={(v) => edit(op(v), merge)}
        />
      )}
    </FormField>
  );
}

/** Values typed as "5, 10, 20"; applied when the field is left. */
export function ListEdit({
  label,
  value,
  onCommit,
  help,
  error,
}: {
  label: string;
  value: string[];
  onCommit: (next: string[]) => void;
  help?: string;
  error?: string | undefined;
}) {
  const [text, setText] = useState(value.join(', '));
  const commit = () => {
    const next = text
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    onCommit(next);
    setText(next.join(', '));
  };
  return (
    <FormField label={label} help={help} error={error}>
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

/** Engine issues for one part, in place; errors announce, warnings are status. */
export function IssueList({
  issues,
  label,
}: {
  issues: readonly ValidationIssue[];
  label: string;
}) {
  if (issues.length === 0) return null;
  return (
    <ul aria-label={label} className="grid gap-1">
      {issues.map((x) => (
        <li key={`${x.code}:${x.path}`}>
          <span
            role={x.severity === 'error' ? 'alert' : 'status'}
            className={x.severity === 'error' ? 'text-xs text-danger' : 'text-xs text-warning'}
          >
            {x.message}
          </span>
        </li>
      ))}
    </ul>
  );
}
