import type { ReactNode } from 'react';
import { formatExpiry } from '../../lib/format.ts';
import { Callout, WizardReview, type WizardReviewSection } from '../../ui/index.ts';
import { PassChecks } from '../brand/pass-checks.tsx';
import type { StepId } from './new-pass-types.ts';
import { describeSchema, type FieldDef, type FormValues } from './schema-form/index.ts';

const shown = (v: unknown, field?: FieldDef) => {
  if (v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (typeof v !== 'string') return JSON.stringify(v);
  const option = field?.options?.find((o) => o.value === v);
  if (option) return option.label;
  return field?.widget === 'datetime' ? formatExpiry(v) || v : v;
};

/** Review: what the pass will be, a section per step with Edit back to it (the state is kept). */
export function ReviewStep({
  orgEditable,
  onEdit,
  org,
  setup,
  mode,
  template,
  release,
  schema,
  input,
  email,
  send,
  warnings: all,
  preview,
  notice,
}: {
  /** The organization step is in this run's rail: its Edit goes back there. */
  orgEditable: boolean;
  onEdit: (step: StepId) => void;
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
  /** The preview's: missing branding and the org's checks get fix rows, the rest one line each. */
  warnings: readonly {
    code: string;
    severity: string;
    message: string;
    path?: string | undefined;
    fix?: { action: string } | undefined;
  }[];
  preview?: ReactNode;
  /** Why Create is off. */
  notice?: ReactNode;
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
  const sections: WizardReviewSection<StepId>[] = [
    {
      id: 'org',
      title: 'Organization',
      // The scope names it: nothing to change here.
      ...(orgEditable ? {} : { edit: false as const }),
      items: [
        { label: 'Organization', value: org },
        { label: 'Mode', value: mode === 'test' ? 'Test' : 'Live' },
      ],
    },
    {
      id: 'template',
      title: 'Template',
      items: [
        { label: 'Template', value: template },
        ...(release ? [{ label: 'Wallet provider', value: 'Apple Wallet' }] : []),
      ],
    },
    {
      id: 'details',
      title: 'Details',
      items: fields.map((f) => ({ id: f.key, label: f.label, value: shown(input[f.key], f) })),
    },
    {
      id: 'holder',
      title: 'Holder',
      items: [
        { label: 'Holder', value: email.trim() || 'No holder yet' },
        {
          label: 'Email',
          value: send && email.trim() ? `Requested for ${email.trim()}` : 'Not requested',
        },
      ],
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
      <WizardReview sections={sections} onEdit={onEdit} preview={preview} level={3} />
      {notice}
    </div>
  );
}
