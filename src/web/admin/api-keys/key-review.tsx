import { Button, KeyValue, type KeyValueItem } from '@/web/ui/index.ts';
import { ROLE_LABELS } from '../orgs/org-roles.ts';
import { EXPIRY } from './key-kind-fields.ts';
import { SCOPE_LABEL } from './queries.ts';
import type { KeyForm, StepId } from './use-key-form.ts';

/** Everything the key will have, by step, each with a way back to change it. */
export function KeyReview({
  form,
  orgId,
  orgName,
  onEdit,
}: {
  form: KeyForm;
  orgId: string | null;
  orgName: string;
  onEdit: (step: StepId) => void;
}) {
  const modeName = form.keyMode === 'test' ? 'Test' : 'Live';
  const sections: { id: StepId; title: string; items: KeyValueItem[] }[] = [
    {
      id: 'basics',
      title: 'Basics',
      items: [
        { label: 'Name', value: form.name.trim() },
        { label: 'Organization', value: orgId === null ? 'Platform: all organizations' : orgName },
        ...(orgId === null
          ? []
          : [
              {
                label: 'Type',
                value: form.kind === 'personal' ? 'Personal, acts as you' : 'Service',
              },
            ]),
        {
          label: 'Expires',
          value: EXPIRY.find((o) => o.value === form.expiry)?.label ?? form.expiry,
        },
      ],
    },
    {
      id: 'access',
      title: 'Access',
      items: [
        {
          label: 'Permissions',
          value: form.role
            ? ROLE_LABELS[form.role]
            : form.scopes.map((s) => SCOPE_LABEL[s] ?? s).join(', '),
        },
        ...(form.scansWrite && orgId !== null
          ? [{ label: 'Terminals', value: String(form.terminalIds.length) }]
          : []),
      ],
    },
    {
      id: 'limits',
      title: 'Limits',
      items: [
        {
          label: 'Allowed IPs',
          value: form.ipAllow.length ? form.ipAllow.join(', ') : 'Any',
          mono: form.ipAllow.length > 0,
        },
        { label: 'Mode', value: modeName },
      ],
    },
  ];
  return (
    <div className="flex flex-col gap-3">
      <div className="divide-y divide-border rounded-lg border border-border-strong bg-surface-raised">
        {sections.map((s) => (
          <section key={s.id} aria-label={s.title} className="p-4">
            <div className="mb-3 flex items-center justify-between gap-2">
              <h4 className="text-sm font-medium text-fg-strong">{s.title}</h4>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Edit ${s.title.toLowerCase()}`}
                onClick={() => onEdit(s.id)}
              >
                Edit
              </Button>
            </div>
            <KeyValue items={s.items} />
          </section>
        ))}
      </div>
      <p className="text-xs text-fg-muted">The key is shown once, after you create it.</p>
    </div>
  );
}
