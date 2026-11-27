import { useNavigate } from '@tanstack/react-router';
import { SkipForward } from 'lucide-react';
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
import {
  HeldSecret,
  LiveCheck,
  type SendResult,
  useRotateSecret,
} from '../../../ui/webhook-setup/index.ts';
import { useAdminTemplateChoices } from './admin-templates.ts';
import {
  useEndpointActions,
  useEndpointQuota,
  useOutboundSetup,
  useSecretCalls,
  useValidateEndpoint,
} from './api.ts';
import {
  checkForm,
  draftOf,
  emptyForm,
  type FormErrors,
  type FormState,
  formOf,
} from './form-state.ts';
import { endpointHost } from './health.ts';
import {
  OUTBOUND_STEPS,
  type OutboundStepId,
  outboundRail,
  SERVER_PHASE,
} from './outbound-rail.ts';
import { comeBack, returnTarget } from './outbound-return.ts';
import { OutboundFinish, OutboundVerifyStep } from './outbound-server.tsx';
import { OutboundReview, OutboundStepEvents, OutboundStepWhere } from './outbound-steps.tsx';

type Created = z.infer<typeof WebhookEndpointCreatedSchema>;

/** A refused URL says why: save-time checks name the reason (host not allowed, not found). */
const urlProblem = (error: unknown) =>
  isApiError(error) && error.status === 422 ? error.message : undefined;

const at = (id: OutboundStepId) => OUTBOUND_STEPS.findIndex((s) => s.id === id);

/** The one place an outbound endpoint is set up: the Connections wizard's "Send to your server" path. */
export function OutboundFlow({
  orgId,
  canManage,
  sandbox = false,
  returnTo,
  onBackToPicker,
  onAnother,
  resume,
}: {
  orgId: string;
  canManage: boolean;
  /** A sandbox counts endpoints against its plan. */
  sandbox?: boolean;
  returnTo?: string | undefined;
  /** Back from the first step: the picker, in Live (a Test org has no picker). */
  onBackToPicker?: (() => void) | undefined;
  /** Finish: start a new setup. */
  onAnother: () => void;
  /** An endpoint that exists: open at Verify (its secret was shown once, at Create). */
  resume?: WebhookEndpointDto | undefined;
}) {
  const navigate = useNavigate();
  const { create, rotate: rotateCall } = useSecretCalls();
  const validate = useValidateEndpoint();
  const guide = useOutboundSetup(orgId);
  const quota = useEndpointQuota(orgId, sandbox);
  const full = !resume && quota !== null && quota.limit !== null && quota.used >= quota.limit;
  const [step, setStep] = useState(resume ? SERVER_PHASE + 1 : 0);
  const [form, setForm] = useState<FormState>(() => (resume ? formOf(resume) : emptyForm()));
  const [showErrors, setShowErrors] = useState(false);
  const [serverUrl, setServerUrl] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<Created | undefined>(
    resume ? { endpoint: resume, secret: '' } : undefined,
  );
  const [saved, setSaved] = useState(Boolean(resume));
  const [delivered, setDelivered] = useState<SendResult>();
  const [finished, setFinished] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const templates = useAdminTemplateChoices(orgId, form.templateMode === 'selected');
  const found = checkForm(form);
  const id = OUTBOUND_STEPS[step]?.id ?? 'test';
  const host = endpointHost({ url: form.url.trim(), urlMasked: form.url.trim() });
  const endpointId = created?.endpoint.id;
  const { test } = useEndpointActions(endpointId ?? '');
  const guard = useUnsavedChangesGuard(!created && form.url !== '');
  const rotate = useRotateSecret((hours) => rotateCall(created?.endpoint.id ?? '', hours));

  /** What blocks a step: the form's problems, and the server's refusal of the URL. */
  const problems = (key: 'where' | 'events'): FormErrors => ({
    ...(key === 'where'
      ? { url: serverUrl ?? found.url }
      : { eventTypes: found.eventTypes, templateIds: found.templateIds }),
  });
  const blocking = (key: 'where' | 'events') =>
    Object.entries(problems(key)).filter(([, v]) => v !== undefined);
  /** Client problems wait for a press on Next; the server's refusal of the URL shows at once. */
  const shown = (key: 'where' | 'events'): FormErrors =>
    showErrors || (key === 'where' && serverUrl) ? problems(key) : {};

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
      window.location.assign(comeBack(back, next.id));
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
      if (blocking(id).length > 0) {
        setShowErrors(true);
        return false;
      }
      setShowErrors(false);
    }
    if (id === 'review') void createEndpoint();
    else if (id === 'test') setFinished(true);
    else setStep((n) => n + 1);
    return undefined;
  }

  const sendTest = async () => {
    const result = await test.mutateAsync();
    if (result.ok) setDelivered(result);
    return result;
  };
  const secret = created?.secret ?? '';
  const floor = resume ? SERVER_PHASE + 1 : SERVER_PHASE;
  const title = resume ? 'Set up your server' : 'Add endpoint';
  const crumbs = [
    { label: 'Connections', to: '/admin/connections', search: { tab: 'webhooks' } },
    { label: resume ? endpointHost(resume) : 'Add endpoint' },
  ];
  const server = id === 'secret' || id === 'verify' || id === 'test';

  if (finished && created && delivered)
    return (
      <>
        <PageHeader title={title} breadcrumbs={crumbs} />
        <OutboundFinish
          host={host}
          result={delivered}
          events={created.endpoint.eventTypes.length}
          onOpen={() => open()}
          onAnother={onAnother}
        />
      </>
    );

  const skip = { label: 'Skip for now', icon: SkipForward, onSelect: () => open() };
  return (
    <>
      <PageHeader title={title} breadcrumbs={crumbs} />
      <Wizard
        steps={outboundRail({
          locked: Boolean(created),
          resumed: Boolean(resume),
          summaries: { where: form.url.trim() ? host : undefined },
        })}
        current={step}
        onStep={(i) => (!created || i >= floor) && setStep(i)}
        lockedReason="Change this on the endpoint."
        onCancel={() => (created ? setLeaving(true) : open())}
        onBack={
          step > (created ? floor : 0)
            ? () => setStep(step - 1)
            : !created && onBackToPicker
              ? onBackToPicker
              : undefined
        }
        onNext={next}
        nextLabel={id === 'review' ? 'Add endpoint' : id === 'test' ? 'Done' : 'Next'}
        nextDisabled={
          !canManage ||
          (full && id === 'where') ||
          (id === 'secret' && !saved) ||
          (id === 'test' && !delivered)
        }
        nextHint={
          !canManage
            ? 'Needs integrations access.'
            : full && id === 'where'
              ? 'Endpoint limit reached.'
              : id === 'secret'
                ? 'Confirm you saved it.'
                : 'Send a test first.'
        }
        barMenu={id === 'test' ? (delivered ? [] : [skip]) : undefined}
        busy={saving}
      >
        {id === 'where' ? (
          <OutboundStepWhere
            quota={quota}
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
        {id === 'review' ? <OutboundReview form={form} onEdit={(to) => setStep(at(to))} /> : null}
        {server && created ? (
          <>
            {id === 'secret' ? (
              <HeldSecret
                held={secret}
                saved={saved}
                onSaved={setSaved}
                rotate={rotate}
                onRotated={() => rotate.reset()}
              />
            ) : null}
            {id === 'verify' ? (
              <OutboundVerifyStep
                guide={guide.data}
                endpointId={created.endpoint.id}
                url={created.endpoint.url ?? form.url.trim()}
                events={created.endpoint.eventTypes.length}
                copied={resume ? undefined : saved}
                rotate={resume ? rotate : undefined}
                onRotated={() => rotate.reset()}
              />
            ) : null}
            {id === 'test' ? (
              <div className="flex max-w-xl min-w-0 flex-col gap-4">
                <LiveCheck
                  mode="send"
                  host={host}
                  canSend={canManage}
                  title={false}
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
