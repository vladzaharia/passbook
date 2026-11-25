import { KeyRound } from 'lucide-react';
import { useState } from 'react';
import type { OrgCapability } from '@/shared/contracts/org-membership.ts';
import { useWizard, WizardDialog, WizardResult } from '@/web/ui/index.ts';
import { KeyDisclosure } from './key-disclosure.tsx';
import { KeyReview } from './key-review.tsx';
import { type ApiKey, useCreateKey } from './queries.ts';
import type { SCOPES } from './scope-rows.tsx';
import { StepAccess } from './step-access.tsx';
import { StepBasics } from './step-basics.tsx';
import { StepLimits } from './step-limits.tsx';
import { FIELD_STEP, HINTS, keySummaries, STEPS, useKeyForm } from './use-key-form.ts';

const DAY = 86_400_000;

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
  const [created, setCreated] = useState<ApiKey & { secret: string }>();
  const summaries = keySummaries(form);
  const w = useWizard({
    open,
    steps: STEPS.map((s) => ({ ...s, summary: summaries[s.id] })),
    errors: form.errors,
    hints: HINTS,
    fieldStep: FIELD_STEP,
    onFinish: async () =>
      setCreated(
        await create.mutateAsync({
          name: form.name.trim(),
          orgId,
          scopes: form.role ? [] : (form.scopes as (typeof SCOPES)[number][]),
          ...(form.role ? { roles: [form.role] } : {}),
          ...(orgId !== null ? { kind: form.kind } : {}),
          ...(form.ipAllow.length ? { ipAllow: form.ipAllow } : {}),
          ...(form.scansWrite ? { terminalIds: form.terminalIds } : {}),
          mode: form.keyMode,
          expiresAt: form.expiry === 'never' ? null : Date.now() + Number(form.expiry) * DAY,
        }),
      ),
  });
  const reset = () => {
    form.reset();
    setCreated(undefined);
  };
  const organization =
    created?.orgId === null ? 'Platform' : created?.orgId === orgId ? orgName : created?.orgId;

  return (
    <WizardDialog
      open={open}
      onOpenChange={onOpenChange}
      title="New API key"
      wizard={w}
      dirty={form.dirty}
      finishLabel="Create key"
      busy={create.isPending}
      onClose={reset}
      result={
        created ? (
          <WizardResult title="Copy your key" icon={<KeyRound aria-hidden />}>
            <KeyDisclosure
              created={created}
              organization={organization ?? ''}
              onDone={() => {
                onOpenChange(false);
                reset();
              }}
            />
          </WizardResult>
        ) : undefined
      }
    >
      {w.id === 'basics' ? (
        <StepBasics
          form={form}
          orgId={orgId}
          orgName={orgName}
          errors={w.errors}
          onEdit={() => w.clearServer()}
        />
      ) : null}
      {w.id === 'access' ? (
        <StepAccess
          form={form}
          orgId={orgId}
          capabilities={capabilities}
          developerOrg={developerOrg}
          errors={w.errors}
        />
      ) : null}
      {w.id === 'limits' ? <StepLimits form={form} orgId={orgId} errors={w.errors} /> : null}
      {w.id === 'review' ? (
        <KeyReview form={form} orgId={orgId} orgName={orgName} onEdit={w.go} />
      ) : null}
    </WizardDialog>
  );
}
