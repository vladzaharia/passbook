import { useState } from 'react';
import type { z } from 'zod';
import type {
  WebhookEndpointCreatedSchema,
  WebhookEndpointDto,
} from '@/shared/contracts/webhooks.ts';
import { isApiError } from '../../../lib/errors.ts';
import { useWizard } from '../../../ui/wizard/use-wizard.ts';
import { WizardDialog } from '../../../ui/wizard/wizard-dialog.tsx';
import { useSecretCalls, useValidateEndpoint } from './api.ts';
import type { TemplateChoices } from './event-fields.tsx';
import { checkForm, draftOf, emptyForm, type FormState } from './form-state.ts';
import { endpointHost } from './health.ts';
import { OUTBOUND_DONE, OutboundDone } from './outbound-done.tsx';
import { OutboundReview, OutboundStepEvents, OutboundStepWhere } from './outbound-steps.tsx';

type Created = z.infer<typeof WebhookEndpointCreatedSchema>;
export type OutboundKind = 'url' | 'capture';

/**
 * What differs between the hosts that mount the outbound steps of the Connections wizard. The
 * wizard locks to the outbound source: it names no organization and has no chooser, and in the
 * Workbench every call it makes rides the Test token.
 */
export interface OutboundHost {
  /** The organization the wizard acts in, fixed by the host: it has no chooser. */
  orgId: string;
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
  { id: 'where', title: 'Destination', heading: 'Where to send', group: 'In PassBook' },
  { id: 'events', title: 'Events', heading: 'Choose events', group: 'In PassBook' },
  { id: 'review', title: 'Review', group: 'In PassBook' },
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
 * The Connections outbound path: the one wizard that sets up a webhook endpoint ("Send events to
 * your server"). Connections' outbound tile mounts it (webhook-setup W7), and the Workbench mounts it
 * in Test through a host adapter. Nothing else creates an endpoint. It is built on the shared Wizard
 * kit and the webhook-setup kit: where, which events, review, then both sides of the setup. PassBook's
 * side is the signing secret (shown once) and a live test send; your server's side is the guide's
 * steps. A sandbox may pick its capture endpoint instead of a URL (no secret, nothing leaves PassBook).
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
        setCreated(await create({ ...draftOf(form), orgId: host.orgId }));
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
      await validate({ ...draftOf(form), orgId: host.orgId });
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
              ...OUTBOUND_DONE,
              body: (
                <OutboundDone
                  orgId={host.orgId}
                  created={created}
                  onDone={() => {
                    host.onFinish(created.endpoint);
                    onOpenChange(false);
                  }}
                />
              ),
            }
          : undefined
      }
    >
      {w.id === 'where' ? (
        <OutboundStepWhere
          sandbox={host.sandbox}
          quota={host.quota}
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
