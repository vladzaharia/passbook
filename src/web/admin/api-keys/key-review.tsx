import { WizardReview, type WizardReviewSection } from '@/web/ui/index.ts';
import { ROLE_LABELS } from '../orgs/org-roles.ts';
import { EXPIRY, PLATFORM_KEY_NEVER } from './key-kind-fields.ts';
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
  const sections: WizardReviewSection<StepId>[] = [
    {
      id: 'basics',
      title: 'Basics',
      items: [
        { label: 'Name', value: form.name.trim() },
        {
          label: 'Organization',
          value: orgId !== null ? orgName : form.onPlatform ? 'Platform' : 'All organizations',
        },
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
        ...(form.onPlatform ? [{ label: "Keys can't", value: PLATFORM_KEY_NEVER }] : []),
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
    <WizardReview
      sections={sections}
      onEdit={onEdit}
      note="The key is shown once, after you create it."
    />
  );
}
