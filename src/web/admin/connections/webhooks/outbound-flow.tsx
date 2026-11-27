import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { z } from 'zod';
import type {
  WebhookEndpointCreatedSchema,
  WebhookEndpointDto,
} from '@/shared/contracts/webhooks.ts';
import { isApiError } from '../../../lib/errors.ts';
import {
  ConfirmDialog,
  PageHeader,
  toast,
  UnsavedChangesDialog,
  useUnsavedChangesGuard,
  Wizard,
} from '../../../ui/index.ts';
import { LiveCheck } from '../../../ui/webhook-setup/index.ts';
import { useAdminTemplateChoices } from './admin-templates.ts';
import {
  useEndpointActions,
  useOutboundSetup,
  useSecretCalls,
  useValidateEndpoint,
} from './api.ts';
import { checkForm, draftOf, emptyForm, type FormState } from './form-state.ts';
import { endpointHost } from './health.ts';
import {
  OUTBOUND_STEPS,
  type OutboundStepId,
  outboundRail,
  SERVER_PHASE,
} from './outbound-rail.ts';
import { OutboundSecretStep, OutboundVerifyStep } from './outbound-server.tsx';
import { OutboundReview, OutboundStepEvents, OutboundStepWhere } from './outbound-steps.tsx';

type Created = z.infer<typeof WebhookEndpointCreatedSchema>;

/** A Workbench link comes back to it: only its own paths, never another site. */
export function returnTarget(value: string | undefined): string | undefined {
  return value?.startsWith('/developers/') && !value.startsWith('//') ? value : undefined;
}

/** A refused URL says why: save-time checks name the reason (host not allowed, not found). */
const urlProblem = (error: unknown) =>
  isApiError(error) && error.status === 422 ? error.message : undefined;

const at = (id: OutboundStepId) => OUTBOUND_STEPS.findIndex((s) => s.id === id);

/**
 * The one place an outbound webhook endpoint is set up ("Send events to your server"), as a path
 * of the Connections wizard: where, events and review in PassBook, Create, then your server's side
 * (the secret, the signature check, a live test send). Nothing else in the admin creates one.
 */
export function OutboundFlow({
  orgId,
  canManage,
  returnTo,
  onBackToPicker,
}: {
  orgId: string;
  canManage: boolean;
  returnTo?: string | undefined;
  /** Back from the first step: the picker, in Live (a Test org has no picker). */
  onBackToPicker?: (() => void) | undefined;
}) {
  const navigate = useNavigate();
  const { create } = useSecretCalls();
  const validate = useValidateEndpoint();
  const guide = useOutboundSetup(orgId);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [showErrors, setShowErrors] = useState(false);
  const [serverUrl, setServerUrl] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Created>();
  const [saved, setSaved] = useState(false);
  const [delivered, setDelivered] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const templates = useAdminTemplateChoices(orgId, form.templateMode === 'selected');
  const found = checkForm(form);
  const id = OUTBOUND_STEPS[step]?.id ?? 'test';
  const host = endpointHost({ url: form.url.trim(), urlMasked: form.url.trim() });
  const endpointId = created?.endpoint.id;
  const { test } = useEndpointActions(endpointId ?? '');
  const guard = useUnsavedChangesGuard(!created && form.url !== '');

  const errors = {
    where: { ...(found.url ? { url: found.url } : {}) },
    events: {
      ...(found.eventTypes ? { eventTypes: found.eventTypes } : {}),
      ...(found.templateIds ? { templateIds: found.templateIds } : {}),
    },
  };
  /** Client problems wait for a press on Next; the server's refusal of the URL shows at once. */
  const shown = (key: 'where' | 'events') =>
    key === 'where'
      ? { ...(showErrors ? errors.where : {}), ...(serverUrl ? { url: serverUrl } : {}) }
      : showErrors
        ? errors.events
        : {};

  const shownAll = (key: 'where' | 'events') => ({
    ...errors[key],
    ...(key === 'where' && serverUrl ? { url: serverUrl } : {}),
  });

  const patch = (p: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...p }));
    if (p.url !== undefined) setServerUrl(undefined);
  };

  /** The dry run on blur: the same static and DNS checks as save, nothing written. */
  async function dryRun() {
    if (found.url) return;
    setChecking(true);
    try {
      await validate({ ...draftOf(form), orgId });
      setServerUrl(undefined);
    } catch (error) {
      setServerUrl(urlProblem(error));
    } finally {
      setChecking(false);
    }
  }

  async function createEndpoint() {
    setSaving(true);
    try {
      setCreated(await create({ ...draftOf(form), orgId }));
      setStep(SERVER_PHASE);
    } catch (error) {
      const why = urlProblem(error);
      if (why) {
        setServerUrl(why);
        setShowErrors(true);
        setStep(at('where'));
      } else toast.error(error, 'Could not add the endpoint');
    } finally {
      setSaving(false);
    }
  }

  function open(endpoint?: WebhookEndpointDto) {
    const next = endpoint ?? created?.endpoint;
    const back = returnTarget(returnTo);
    if (back && next) {
      window.location.assign(`${back}${back.includes('?') ? '&' : '?'}endpoint=${next.id}`);
      return;
    }
    void navigate(
      next
        ? {
            to: '/admin/connections/webhooks/$endpointId',
            params: { endpointId: next.id },
            replace: true,
          }
        : { to: '/admin/connections', search: { tab: 'webhooks' }, replace: true },
    );
  }

  /** False keeps the step: the Wizard focuses the first error and announces the count. */
  function next(): boolean | undefined {
    if (id === 'where' || id === 'events') {
      if (Object.keys(shownAll(id)).length > 0) {
        setShowErrors(true);
        return false;
      }
      setShowErrors(false);
    }
    if (id === 'review') void createEndpoint();
    else if (id === 'test') open();
    else setStep((n) => n + 1);
    return undefined;
  }

  const sendTest = async () => {
    const result = await test.mutateAsync();
    if (result.ok) setDelivered(true);
    return result;
  };
  const secret = created?.secret ?? '';
  const crumbs = [
    { label: 'Connections', to: '/admin/connections', search: { tab: 'webhooks' } },
    { label: 'Add endpoint' },
  ];
  const server = id === 'secret' || id === 'verify' || id === 'test';

  return (
    <>
      <PageHeader title="Add endpoint" breadcrumbs={crumbs} />
      <Wizard
        steps={outboundRail({
          locked: Boolean(created),
          summaries: { where: form.url.trim() ? host : undefined },
        })}
        current={step}
        onStep={(i) => (!created || i >= SERVER_PHASE) && setStep(i)}
        lockedReason="Change this on the endpoint."
        onCancel={() => (created ? setLeaving(true) : open())}
        onBack={
          step > (created ? SERVER_PHASE : 0)
            ? () => setStep(step - 1)
            : !created && onBackToPicker
              ? onBackToPicker
              : undefined
        }
        onNext={next}
        nextLabel={id === 'review' ? 'Add endpoint' : id === 'test' ? 'Done' : 'Next'}
        nextDisabled={!canManage || (id === 'secret' && !saved) || (id === 'test' && !delivered)}
        nextHint={
          !canManage
            ? 'Needs integrations access.'
            : id === 'secret'
              ? 'Copy the secret.'
              : 'Send a test first.'
        }
        barMenu={
          id === 'test' && !delivered
            ? [{ label: 'Skip for now', onSelect: () => open() }]
            : undefined
        }
        busy={saving}
      >
        {id === 'where' ? (
          <OutboundStepWhere
            sandbox={false}
            quota={null}
            kind="url"
            onKind={() => undefined}
            form={form}
            onChange={patch}
            errors={shown('where')}
            checking={checking}
            onUrlBlur={() => void dryRun()}
          />
        ) : null}
        {id === 'events' ? (
          <OutboundStepEvents
            form={form}
            onChange={patch}
            errors={shown('events')}
            templates={templates}
          />
        ) : null}
        {id === 'review' ? (
          <OutboundReview level={3} kind="url" form={form} onEdit={(to) => setStep(at(to))} />
        ) : null}
        {server && created ? (
          <>
            {id === 'secret' ? (
              <OutboundSecretStep secret={secret} saved={saved} onSaved={setSaved} />
            ) : null}
            {id === 'verify' ? (
              <OutboundVerifyStep
                guide={guide.data}
                secret={secret}
                endpointId={created.endpoint.id}
                url={created.endpoint.url ?? form.url.trim()}
                host={host}
                events={created.endpoint.eventTypes.length}
              />
            ) : null}
            {id === 'test' ? (
              <div className="flex max-w-xl min-w-0 flex-col gap-4">
                <LiveCheck
                  mode="send"
                  host={host}
                  canSend={canManage}
                  hint={guide.data?.test.text}
                  send={sendTest}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </Wizard>
      <ConfirmDialog
        open={leaving}
        onOpenChange={setLeaving}
        title="Leave setup?"
        description="The endpoint stays. Test it from its page."
        confirmLabel="Leave"
        cancelLabel="Keep setting up"
        onConfirm={() => open()}
      />
      <UnsavedChangesDialog blocker={guard} />
    </>
  );
}
