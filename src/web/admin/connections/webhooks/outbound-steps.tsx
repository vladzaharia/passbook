import { WizardReview, type WizardReviewSection } from '../../../ui/wizard/wizard-review.tsx';
import { UrlField } from './endpoint-fields.tsx';
import { EventFields, type TemplateChoices } from './event-fields.tsx';
import type { FormErrors, FormState } from './form-state.ts';
import { endpointHost } from './health.ts';

/** The destination: your server's URL, checked on blur. */
export function OutboundStepWhere({
  form,
  onChange,
  errors,
  checking,
  onUrlBlur,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: Record<string, string | undefined>;
  checking: boolean;
  onUrlBlur: () => void;
}) {
  return (
    <UrlField
      autoFocus
      value={form}
      onChange={onChange}
      errors={errors}
      checking={checking}
      onUrlBlur={onUrlBlur}
      urlHelp="https only."
    />
  );
}

/** The events and templates the endpoint receives: the shared fields without the URL. */
export function OutboundStepEvents({
  form,
  onChange,
  errors,
  templates,
}: {
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: FormErrors;
  templates: TemplateChoices;
}) {
  return <EventFields value={form} onChange={onChange} errors={errors} templates={templates} />;
}

/** Everything the endpoint will have, by step, each with a way back. */
export function OutboundReview({
  form,
  onEdit,
}: {
  form: FormState;
  onEdit: (step: 'where' | 'events') => void;
}) {
  const sections: WizardReviewSection<'where' | 'events'>[] = [
    {
      id: 'where',
      title: 'Endpoint',
      items: [
        {
          label: 'URL',
          value: endpointHost({ url: form.url.trim(), urlMasked: form.url.trim() }),
        },
        ...(form.description.trim()
          ? [{ label: 'Description', value: form.description.trim() }]
          : []),
      ],
    },
    {
      id: 'events',
      title: 'Events',
      items: [
        { label: 'Events', value: String(form.eventTypes.length) },
        {
          label: 'Templates',
          value:
            form.templateMode === 'all' ? 'All templates' : `${form.templateIds.length} selected`,
        },
      ],
    },
  ];
  return <WizardReview level={3} sections={sections} onEdit={onEdit} />;
}
