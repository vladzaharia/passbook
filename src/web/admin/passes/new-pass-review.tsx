import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button, Callout, Card, CardBody } from '../../ui/index.ts';
import { describeSchema, type FormValues } from './schema-form/index.ts';

const shown = (v: unknown) =>
  v === undefined || v === ''
    ? null
    : typeof v === 'string'
      ? v
      : Array.isArray(v)
        ? `${v.length} ${v.length === 1 ? 'item' : 'items'}`
        : JSON.stringify(v);

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
  warnings: all,
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
  /** The preview's: missing branding gets its own callout, the other warnings one line each. */
  warnings: readonly { code: string; severity: string; message: string }[];
  error: ReactNode;
}) {
  const brandingMissing = all.some((w) => w.code === 'PLATFORM_BRANDING');
  const warnings = all
    .filter((w) => w.severity === 'warning' && w.code !== 'PLATFORM_BRANDING')
    .map((w) => w.message);
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
                {/* A dl row holds only dt and dd, so Edit sits inside the dd. */}
                <dd className="flex min-w-0 flex-1 items-center gap-3 text-sm text-fg">
                  <span className="min-w-0 flex-1 truncate">
                    {r.value ?? <span className="text-fg-subtle">—</span>}
                  </span>
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
                </dd>
              </div>
            ))}
          </dl>
        </CardBody>
      </Card>
      {error}
    </div>
  );
}
