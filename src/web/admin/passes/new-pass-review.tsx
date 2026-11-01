import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Callout, Card, CardBody } from '../../ui/index.ts';
import { describeSchema, type FormValues } from './schema-form/index.ts';

const shown = (v: unknown) =>
  v === undefined || v === '' ? null : typeof v === 'string' ? v : JSON.stringify(v);

interface Row {
  label: string;
  value: ReactNode;
  step?: number;
}

/** Review: one row per choice with Edit back to its step (the state is kept). */
export function ReviewStep({
  org,
  template,
  schema,
  input,
  email,
  send,
  steps,
  onEdit,
  brandingMissing,
  warnings,
  error,
}: {
  org: string | undefined;
  template: string | undefined;
  schema: unknown;
  input: FormValues;
  email: string;
  send: boolean;
  steps: { org?: number; template: number; details: number; holder: number };
  onEdit: (step: number) => void;
  brandingMissing: boolean;
  /** The preview's other warnings (lint), one line each. */
  warnings: readonly string[];
  error: ReactNode;
}) {
  const fields = describeSchema(schema)
    .flatMap((g) => g.fields)
    .filter((f) => f.required || shown(input[f.key]) !== null)
    .slice(0, 4);
  const rows: Row[] = [
    { label: 'Organization', value: org, ...(steps.org !== undefined ? { step: steps.org } : {}) },
    { label: 'Template', value: template, step: steps.template },
    ...fields.map((f) => ({ label: f.label, value: shown(input[f.key]), step: steps.details })),
    { label: 'Holder', value: email.trim() || 'No holder yet', step: steps.holder },
    ...(send && email.trim()
      ? [{ label: 'Sends email to', value: email.trim(), step: steps.holder }]
      : []),
  ];
  return (
    <div className="flex flex-col gap-4">
      {brandingMissing ? (
        <Callout tone="warning" title="No pass branding">
          The pass shows the starter logo and icon.
        </Callout>
      ) : null}
      {warnings.length > 0 ? (
        <Callout
          tone="warning"
          title={`${warnings.length} ${warnings.length === 1 ? 'warning' : 'warnings'}`}
          items={warnings}
        />
      ) : null}
      <Card>
        <CardBody>
          <dl className="divide-y divide-border">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex min-h-11 items-center gap-3 py-2 first:pt-0 last:pb-0"
              >
                <dt className="w-32 shrink-0 text-sm text-fg-muted">{r.label}</dt>
                <dd className="min-w-0 flex-1 truncate text-sm text-fg">
                  {r.value ?? <span className="text-fg-subtle">—</span>}
                </dd>
                {r.step !== undefined ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    iconStart={<Pencil aria-hidden />}
                    aria-label={`Edit ${r.label.toLowerCase()}`}
                    onClick={() => onEdit(r.step as number)}
                  >
                    <span className="max-sm:sr-only">Edit</span>
                  </Button>
                ) : null}
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
      {error}
    </div>
  );
}
