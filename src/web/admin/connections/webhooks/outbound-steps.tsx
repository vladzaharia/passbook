import { Server, Webhook } from 'lucide-react';
import { OptionTile } from '../../../ui/option-tile.tsx';
import { WizardReview, type WizardReviewSection } from '../../../ui/wizard/wizard-review.tsx';
import { UrlField } from './endpoint-fields.tsx';
import { EventFields, type TemplateChoices } from './event-fields.tsx';
import type { FormErrors, FormState } from './form-state.ts';
import { endpointHost } from './health.ts';
import type { OutboundKind } from './outbound-wizard.tsx';

/** The destination: your server's URL, or (in a sandbox) the capture endpoint. */
export function OutboundStepWhere({
  sandbox,
  quota,
  kind,
  onKind,
  form,
  onChange,
  errors,
  checking,
  onUrlBlur,
}: {
  /** A sandbox may also pick the built-in capture endpoint. */
  sandbox: boolean;
  quota: { used: number; limit: number | null } | null;
  kind: OutboundKind;
  onKind: (kind: OutboundKind) => void;
  form: FormState;
  onChange: (patch: Partial<FormState>) => void;
  errors: Record<string, string | undefined>;
  checking: boolean;
  onUrlBlur: () => void;
}) {
  return (
    <>
      {sandbox ? (
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
        <UrlField
          autoFocus
          value={form}
          onChange={onChange}
          errors={errors}
          checking={checking}
          onUrlBlur={onUrlBlur}
          urlHelp="https only. A signing secret is shown once after you add this."
        />
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
  return <EventFields value={form} onChange={onChange} errors={errors} templates={templates} />;
}

/** Everything the endpoint will have, by step, each with a way back. */
export function OutboundReview({
  kind,
  form,
  onEdit,
  level,
}: {
  kind: OutboundKind;
  form: FormState;
  onEdit: (step: 'where' | 'events') => void;
  /** The section titles' heading level: 3 under a page's step heading, 4 under a dialog's. */
  level?: 3 | 4;
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
      {...(level ? { level } : {})}
      sections={sections}
      onEdit={onEdit}
      note={kind === 'url' ? 'The signing secret is shown once, after you add it.' : undefined}
    />
  );
}
