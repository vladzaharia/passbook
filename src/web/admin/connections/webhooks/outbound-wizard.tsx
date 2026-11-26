import { Webhook } from 'lucide-react';
import { useState } from 'react';
import type { z } from 'zod';
import type {
  WebhookEndpointCreatedSchema,
  WebhookEndpointDto,
} from '@/shared/contracts/webhooks.ts';
import { isApiError } from '../../../lib/errors.ts';
import { SecretReveal } from '../../../ui/secret-reveal.tsx';
import { VerifyGuide } from '../../../ui/webhooks/verify-guide.tsx';
import { useWizard } from '../../../ui/wizard/use-wizard.ts';
import { WizardDialog } from '../../../ui/wizard/wizard-dialog.tsx';
import { useSecretCalls, useValidateEndpoint } from './api.ts';
import type { TemplateChoices } from './endpoint-fields.tsx';
import { checkForm, draftOf, emptyForm, type FormState } from './form-state.ts';
import { endpointHost } from './health.ts';
import { OutboundReview, OutboundStepEvents, OutboundStepWhere } from './outbound-steps.tsx';
import { TestSend } from './test-send.tsx';

type Created = z.infer<typeof WebhookEndpointCreatedSchema>;
export type OutboundKind = 'url' | 'capture';

/**
 * What differs between the hosts that mount the outbound steps of the Connections wizard. The
 * wizard locks to the outbound source: it names no organization and has no chooser, and in the
 * Workbench every call it makes rides the Test token.
 */
export interface OutboundHost {
  /** A sandbox also offers its built-in capture endpoint, and counts endpoints against its plan. */
  sandbox: boolean;
  quota: { used: number; limit: number | null } | null;
  /** The templates an endpoint may be limited to, read through the host's client. */
  useTemplateChoices: (selected: boolean) => TemplateChoices;
  /** The built-in capture endpoint, made if the sandbox has none yet. */
  ensureCapture: () => Promise<WebhookEndpointDto>;
  /** Done: the endpoint to select next. */
  onFinish: (endpoint: WebhookEndpointDto) => void;
}

const STEPS = [
  { id: 'where', title: 'Destination', heading: 'Where to send' },
  { id: 'events', title: 'Events', heading: 'Choose events' },
  { id: 'review', title: 'Review' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const FIELD_STEP: Record<string, StepId> = {
  url: 'where',
  eventTypes: 'events',
  templateIds: 'events',
};

/** A refused URL says why: save-time checks name the reason (host not allowed, not found). */
const urlProblem = (error: unknown) =>
  isApiError(error) && error.status === 422 ? error.message : undefined;

/**
 * Send events to your server: the outbound path of the Connections wizard, in a dialog. Where, which
 * events, review, then the signing secret once, with the verify guide and a test send. A sandbox may
 * pick its capture endpoint instead of a URL (no secret, nothing leaves PassBook).
 */
export function OutboundWizard({
  open,
  onOpenChange,
  host,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  host: OutboundHost;
}) {
  const { create } = useSecretCalls();
  const validate = useValidateEndpoint();
  const [kind, setKind] = useState<OutboundKind>('url');
  const [form, setForm] = useState<FormState>(emptyForm);
  const [serverUrl, setServerUrl] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [created, setCreated] = useState<Created>();
  const templates = host.useTemplateChoices(form.templateMode === 'selected');
  const url = kind === 'url';
  const found = checkForm(form);
  const errors = {
    where: url
      ? { ...(found.url ? { url: found.url } : {}), ...(serverUrl ? { url: serverUrl } : {}) }
      : {},
    events: url
      ? {
          ...(found.eventTypes ? { eventTypes: found.eventTypes } : {}),
          ...(found.templateIds ? { templateIds: found.templateIds } : {}),
        }
      : {},
  };
  const dirty = !created && (form.url !== '' || form.description !== '' || kind !== 'url');

  const w = useWizard<StepId>({
    open,
    steps: STEPS.map((s) => ({
      ...s,
      ...(s.id === 'events' && !url ? { skip: true } : {}),
      summary:
        s.id === 'where'
          ? url
            ? form.url.trim() && endpointHost({ url: form.url.trim(), urlMasked: form.url.trim() })
            : 'Capture endpoint'
          : s.id === 'events' && url
            ? `${form.eventTypes.length} events`
            : undefined,
    })),
    errors,
    hints: { where: 'Enter the URL.', events: 'Pick an event.' },
    fieldStep: FIELD_STEP,
    onFinish: async () => {
      if (!url) {
        host.onFinish(await host.ensureCapture());
        onOpenChange(false);
        return;
      }
      try {
        setCreated(await create(draftOf(form)));
      } catch (error) {
        const why = urlProblem(error);
        if (why) setServerUrl(why);
        throw error;
      }
    },
  });

  /** The dry run on blur: the same static and DNS checks as save, nothing written. */
  async function dryRun() {
    if (found.url) return;
    setChecking(true);
    try {
      await validate(draftOf(form));
      setServerUrl(undefined);
    } catch (error) {
      setServerUrl(urlProblem(error));
    } finally {
      setChecking(false);
    }
  }
  const patch = (p: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...p }));
    if (p.url !== undefined) setServerUrl(undefined);
  };

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Add endpoint"
      wizard={w}
      dirty={dirty}
      finishLabel={url ? 'Add endpoint' : 'Use capture endpoint'}
      onClose={() => {
        setKind('url');
        setForm(emptyForm());
        setServerUrl(undefined);
        setCreated(undefined);
      }}
      result={
        created
          ? {
              title: 'Endpoint added',
              icon: <Webhook aria-hidden />,
              body: (
                <SecretReveal
                  fields={[
                    {
                      label: 'Signing secret',
                      value: created.secret,
                      copyLabel: 'Copy signing secret',
                    },
                  ]}
                  doneLabel="Done"
                  onDone={() => {
                    host.onFinish(created.endpoint);
                    onOpenChange(false);
                  }}
                >
                  <details className="text-sm">
                    <summary className="cursor-pointer text-fg-muted pointer-coarse:min-h-11">
                      How to verify the signature
                    </summary>
                    <VerifyGuide className="pt-3" />
                  </details>
                  <TestSend
                    endpointId={created.endpoint.id}
                    host={endpointHost(created.endpoint)}
                    canManage
                  />
                </SecretReveal>
              ),
            }
          : undefined
      }
    >
      {w.id === 'where' ? (
        <OutboundStepWhere
          host={host}
          kind={kind}
          onKind={setKind}
          form={form}
          onChange={patch}
          errors={errors.where}
          checking={checking}
          onUrlBlur={() => void dryRun()}
        />
      ) : null}
      {w.id === 'events' ? (
        <OutboundStepEvents
          form={form}
          onChange={patch}
          errors={errors.events}
          templates={templates}
        />
      ) : null}
      {w.id === 'review' ? <OutboundReview kind={kind} form={form} onEdit={w.go} /> : null}
    </WizardDialog>
  );
}
