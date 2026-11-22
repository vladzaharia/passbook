import { Pencil } from 'lucide-react';
import type { ReactNode } from 'react';
import { formatExpiry } from '../../lib/format.ts';
import { Button, Callout, Card, CardBody } from '../../ui/index.ts';
import { PassChecks } from '../brand/pass-checks.tsx';
import { describeSchema, type FieldDef, type FormValues } from './schema-form/index.ts';

const shown = (v: unknown, field?: FieldDef) => {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v !== 'string') return JSON.stringify(v);
  const option = field?.options?.find((o) => o.value === v);
  if (option) return option.label;
  return field?.widget === 'datetime' ? formatExpiry(v) || v : v;
};

interface Row {
  label: string;
  value: ReactNode;
  step?: number;
}

/** Review: one row per choice with Edit back to its step (the state is kept). */
export function ReviewStep({
  org,
  setup,
  mode,
  template,
  release,
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
  /** The org's setup rows; `onFixed` reads the preview's warnings again once an image landed. */
  setup?: { orgId: string | undefined; templateId: string | undefined; onFixed: () => void };
  mode: 'live' | 'test';
  template: string | undefined;
  release?: { id: string; generation: number; provider: 'apple' } | undefined;
  schema: unknown;
  input: FormValues;
  email: string;
  send: boolean;
  steps: { org?: number; template: number; details: number; holder: number };
  onEdit: (step: number) => void;
  /** The preview's: missing branding and the org's checks get fix rows, the rest one line each. */
  warnings: readonly {
    code: string;
    severity: string;
    message: string;
    path?: string | undefined;
    fix?: { action: string } | undefined;
  }[];
  error: ReactNode;
}) {
  const warnings = all
    // The org's own Add support row says the same as BACK_CONTACT, so only one of them shows.
    .filter(
      (w) =>
        w.severity === 'warning' &&
        w.code !== 'PLATFORM_BRANDING' &&
        !(w.code === 'BACK_CONTACT' && setup?.orgId),
    )
    .map((w) => w.message);
  const fields = describeSchema(schema)
    .flatMap((g) => g.fields)
    .filter((f) => f.required || shown(input[f.key], f) !== null);
  const rows: Row[] = [
    { label: 'Organization', value: org, ...(steps.org !== undefined ? { step: steps.org } : {}) },
    { label: 'Mode', value: mode === 'test' ? 'Test' : 'Live' },
    { label: 'Template', value: template, step: steps.template },
    ...(release ? [{ label: 'Wallet provider', value: 'Apple Wallet' }] : []),
    ...fields.map((f) => ({ label: f.label, value: shown(input[f.key], f), step: steps.details })),
    { label: 'Holder', value: email.trim() || 'No holder yet', step: steps.holder },
    {
      label: 'Email',
      value: send && email.trim() ? `Requested for ${email.trim()}` : 'Not requested',
      step: steps.holder,
    },
  ];
  return (
    <div className="flex flex-col gap-4">
      {setup?.orgId ? (
        <PassChecks
          orgId={setup.orgId}
          templateId={setup.templateId}
          warnings={all}
          onFixed={setup.onFixed}
        />
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
                className="flex min-h-11 flex-wrap items-start gap-2 py-2 first:pt-0 last:pb-0 sm:flex-nowrap sm:items-center sm:gap-3"
              >
                <dt className="w-full shrink-0 text-sm text-fg-muted sm:w-32">{r.label}</dt>
                {/* A dl row holds only dt and dd, so Edit sits inside the dd. */}
                <dd className="flex min-w-0 flex-1 items-center gap-3 text-sm text-fg">
                  <span className="min-w-0 flex-1 break-words">
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
