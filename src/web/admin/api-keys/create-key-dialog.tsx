import { KeyRound } from 'lucide-react';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { cn } from '@/web/lib/cn.ts';
import { errorMessage, isApiError } from '@/web/lib/errors.ts';
import { prefersReducedMotion, useChangeCount } from '@/web/lib/motion.ts';
import { Button, Dialog, DialogContent, Form, useFormErrors } from '@/web/ui/index.ts';
import { ROLE_LABELS } from '../orgs/org-roles.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import { KeyReview } from './key-review.tsx';
import { KeyStepper } from './key-stepper.tsx';
import { type ApiKey, useCreateKey } from './queries.ts';
import type { SCOPES } from './scope-rows.tsx';
import { StepAccess } from './step-access.tsx';
import { StepBasics } from './step-basics.tsx';
import { StepLimits } from './step-limits.tsx';
import { FIELD_STEP, STEPS, type StepId, useKeyForm } from './use-key-form.ts';

const DAY = 86_400_000;
const HEADING: Record<StepId, string> = {
  basics: 'Name the key',
  access: 'What it can do',
  limits: 'Where it works',
  review: 'Check and create',
};
const HINT: Record<string, string> = {
  basics: 'Name the key.',
  access: 'Pick access.',
  limits: 'Fix the IPs.',
};

export interface CreateKeyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  principal: string;
  orgId: string | null;
  orgName: string;
  capabilities: readonly OrgCapability[] | null;
  developerOrg: boolean;
}

export function CreateKeyDialog({
  open,
  onOpenChange,
  principal,
  orgId,
  orgName,
  capabilities,
  developerOrg,
}: CreateKeyDialogProps) {
  const create = useCreateKey(principal);
  const form = useKeyForm(open, orgId, capabilities, developerOrg);
  const [step, setStep] = useState(0);
  const [server, setServer] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [created, setCreated] = useState<ApiKey & { secret: string }>();
  const stepId = STEPS[step]?.id ?? 'basics';
  const found = stepId === 'review' ? undefined : form.errors[stepId];
  const check = useFormErrors(found ?? {});
  const errors: Record<string, string | undefined> = { ...server, ...check.errors };
  const heading = useRef<HTMLHeadingElement>(null);
  const previous = useRef(step);
  const direction = step >= previous.current ? 1 : -1;
  const changed = useChangeCount(step);
  useEffect(() => {
    previous.current = step;
    if (changed) heading.current?.focus({ preventScroll: true });
  }, [step, changed]);

  function close() {
    onOpenChange(false);
    form.reset();
    setStep(0);
    setServer({});
    check.reset();
    setFormError(undefined);
    setCreated(undefined);
  }

  function go(next: number) {
    check.reset();
    setFormError(undefined);
    setStep(next);
  }

  async function submit() {
    setFormError(undefined);
    try {
      const result = await create.mutateAsync({
        name: form.name.trim(),
        orgId,
        scopes: form.role ? [] : (form.scopes as (typeof SCOPES)[number][]),
        ...(form.role ? { roles: [form.role] } : {}),
        ...(orgId !== null ? { kind: form.kind } : {}),
        ...(form.ipAllow.length ? { ipAllow: form.ipAllow } : {}),
        ...(form.scansWrite ? { terminalIds: form.terminalIds } : {}),
        mode: form.keyMode,
        expiresAt: form.expiry === 'never' ? null : Date.now() + Number(form.expiry) * DAY,
      });
      setCreated(result);
    } catch (cause) {
      if (isApiError(cause) && Object.keys(cause.fields).length > 0) {
        setServer(cause.fields);
        const field = Object.keys(cause.fields).find((f) => FIELD_STEP[f]);
        const at = STEPS.findIndex((s) => s.id === (field && FIELD_STEP[field]));
        if (at >= 0) go(at);
      } else setFormError(errorMessage(cause));
    }
  }

  if (created) {
    return (
      <Dialog open={open} onOpenChange={() => undefined}>
        <DialogContent
          size="md"
          closeButton={false}
          title={
            <span className="inline-flex items-center gap-2">
              <span data-verb-done="" className="inline-flex text-accent-fg [&>svg]:size-4">
                <KeyRound aria-hidden />
              </span>
              Copy your key
            </span>
          }
          onInteractOutside={(e) => e.preventDefault()}
          onEscapeKeyDown={(e) => e.preventDefault()}
        >
          <KeyDisclosure
            created={created}
            organization={
              created.orgId === null
                ? 'Platform'
                : created.orgId === orgId
                  ? orgName
                  : created.orgId
            }
            onDone={close}
          />
        </DialogContent>
      </Dialog>
    );
  }

  const last = step === STEPS.length - 1;
  const blocked = Boolean(found);
  const summaries: Record<StepId, string | undefined> = {
    basics: form.name.trim(),
    access: form.role
      ? ROLE_LABELS[form.role]
      : `${form.scopes.length} scope${form.scopes.length === 1 ? '' : 's'}`,
    limits: form.ipAllow.length
      ? `${form.ipAllow.length} IP${form.ipAllow.length === 1 ? '' : 's'}`
      : 'Any IP',
    review: undefined,
  };
  return (
    <Dialog open={open} dirty={form.dirty} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent
        size="xl"
        title="New API key"
        footer={
          <>
            <Button variant="ghost" className="sm:mr-auto" onClick={close}>
              Cancel
            </Button>
            {blocked ? (
              <span className="self-center text-xs text-fg-muted max-sm:hidden">
                {HINT[stepId]}
              </span>
            ) : null}
            {step > 0 ? (
              <Button variant="outline" onClick={() => go(step - 1)}>
                Back
              </Button>
            ) : null}
            <Button type="submit" form="new-key" disabled={blocked} loading={create.isPending}>
              {last ? 'Create key' : 'Next'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-5 md:flex-row md:gap-8">
          <div className="md:sticky md:top-0 md:self-start">
            <KeyStepper
              steps={STEPS.map((s) => ({ ...s, summary: summaries[s.id] }))}
              current={step}
              onStep={go}
            />
          </div>
          <Form
            id="new-key"
            className="@container min-w-0 flex-1 md:min-h-[24rem]"
            invalid={blocked}
            onInvalid={check.form.onInvalid}
            onValid={() => (last ? submit() : go(step + 1))}
          >
            <div
              key={step}
              className={cn('flex flex-col gap-5', changed > 0 && 'wl-step')}
              style={
                {
                  '--wl-step-x': `${direction * (prefersReducedMotion() ? 0 : 16)}px`,
                } as CSSProperties
              }
            >
              <h3
                ref={heading}
                tabIndex={-1}
                className="text-base font-semibold text-fg-strong outline-none"
              >
                {HEADING[stepId]}
              </h3>
              {stepId === 'basics' ? (
                <StepBasics
                  form={form}
                  orgId={orgId}
                  orgName={orgName}
                  errors={errors}
                  onEdit={() => setServer({})}
                />
              ) : null}
              {stepId === 'access' ? (
                <StepAccess
                  form={form}
                  orgId={orgId}
                  capabilities={capabilities}
                  developerOrg={developerOrg}
                  errors={errors}
                />
              ) : null}
              {stepId === 'limits' ? (
                <StepLimits form={form} orgId={orgId} errors={errors} />
              ) : null}
              {stepId === 'review' ? (
                <KeyReview
                  form={form}
                  orgId={orgId}
                  orgName={orgName}
                  onEdit={(id) => go(STEPS.findIndex((s) => s.id === id))}
                />
              ) : null}
              {formError ? <p className="text-sm text-danger">{formError}</p> : null}
            </div>
          </Form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
