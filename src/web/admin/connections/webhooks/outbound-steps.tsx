import { Server, Webhook } from 'lucide-react';
import { FormField } from '../../../ui/field.tsx';
import { Input } from '../../../ui/input.tsx';
import { OptionTile } from '../../../ui/option-tile.tsx';
import { WizardReview, type WizardReviewSection } from '../../../ui/wizard/wizard-review.tsx';
import { EndpointFields, type TemplateChoices } from './endpoint-fields.tsx';
import type { FormErrors, FormState } from './form-state.ts';
import { endpointHost } from './health.ts';
import type { OutboundHost, OutboundKind } from './outbound-wizard.tsx';

/** The destination: your server's URL, or (in a sandbox) the capture endpoint. */
export function OutboundStepWhere({
  host,
  kind,
  onKind,
  form,
  onChange,
  errors,
  checking,
  onUrlBlur,
}: {
  host: OutboundHost;
  kind: OutboundKind;
  onKind: (kind: OutboundKind) => void;
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: Record<string, string | undefined>;
  checking: boolean;
  onUrlBlur: () => void;
}) {
  const quota = host.quota;
  return (
    <>
      {host.sandbox ? (
        <fieldset className="flex min-w-0 flex-col">
          <legend className="mb-2 text-sm font-medium text-fg">Send to</legend>
          <div className="grid gap-3 @md:grid-cols-2">
            <OptionTile
              name="endpoint-kind"
              value="url"
              label="Your server"
              description="PassBook posts signed Test events to a URL."
              icon={Server}
              checked={kind === 'url'}
              onSelect={() => onKind('url')}
            />
            <OptionTile
              name="endpoint-kind"
              value="capture"
              label="Capture endpoint"
              description="Stored and signed, never sent. Inspect it here."
              icon={Webhook}
              checked={kind === 'capture'}
              onSelect={() => onKind('capture')}
            />
          </div>
        </fieldset>
      ) : null}
      {kind === 'url' ? (
        <FormField
          label="URL"
          required
          error={errors.url}
          help={
            errors.url
              ? undefined
              : 'https only. A signing secret is shown once after you add this.'
          }
        >
          {(f) => (
            <Input
              {...f}
              data-autofocus
              data-draft
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://example.com/hooks/passbook"
              aria-busy={checking || undefined}
              value={form.url}
              onChange={(e) => onChange({ url: e.target.value })}
              onBlur={onUrlBlur}
            />
          )}
        </FormField>
      ) : null}
      {kind === 'url' ? (
        <FormField label="Description">
          {(f) => (
            <Input
              {...f}
              data-draft
              maxLength={120}
              value={form.description}
              onChange={(e) => onChange({ description: e.target.value })}
            />
          )}
        </FormField>
      ) : null}
      {quota && quota.limit !== null ? (
        <p
          role="status"
          className="text-sm text-fg-muted"
        >{`${quota.used} of ${quota.limit} endpoints`}</p>
      ) : null}
    </>
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
  return (
    <EndpointFields
      value={form}
      onChange={onChange}
      errors={errors}
      templates={templates}
      hideDestination
    />
  );
}

/** Everything the endpoint will have, by step, each with a way back. */
export function OutboundReview({
  kind,
  form,
  onEdit,
}: {
  kind: OutboundKind;
  form: FormState;
  onEdit: (step: 'where' | 'events') => void;
}) {
  const sections: WizardReviewSection<'where' | 'events'>[] = [
    {
      id: 'where',
      title: 'Destination',
      items:
        kind === 'url'
          ? [
              {
                label: 'URL',
                value: endpointHost({ url: form.url.trim(), urlMasked: form.url.trim() }),
              },
              ...(form.description.trim()
                ? [{ label: 'Description', value: form.description.trim() }]
                : []),
            ]
          : [{ label: 'Send to', value: 'Capture endpoint' }],
    },
    ...(kind === 'url'
      ? [
          {
            id: 'events' as const,
            title: 'Events',
            items: [
              { label: 'Events', value: String(form.eventTypes.length) },
              {
                label: 'Templates',
                value:
                  form.templateMode === 'all'
                    ? 'All templates'
                    : `${form.templateIds.length} selected`,
              },
            ],
          },
        ]
      : []),
  ];
  return (
    <WizardReview
      sections={sections}
      onEdit={onEdit}
      note={kind === 'url' ? 'The signing secret is shown once, after you add it.' : undefined}
    />
  );
}
