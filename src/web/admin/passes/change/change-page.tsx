import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { useOrgScope } from '../../../lib/org-filter.tsx';
import { orgPath } from '../../../lib/scope.ts';
import {
  Button,
  Callout,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  Skeleton,
  Wizard,
} from '../../../ui/index.ts';
import { ForbiddenPage } from '../../../ui/layout/error-pages.tsx';
import { useImport } from '../import/api.ts';
import { BeforeAfter } from './before-after.tsx';
import { ChangeStep } from './change-step.tsx';
import { CHANGE_COPY as C } from './copy.ts';
import { HoldersStep } from './holders-step.tsx';
import type { ChangeKind } from './model.ts';
import { ReviewStep, willChange } from './review-step.tsx';
import { type ChangeSelection, canChangePasses, takeSelection } from './selection.ts';
import { useChangeWizard } from './use-change-wizard.ts';

const STEPS = [
  { id: 'change', title: C.steps.change },
  { id: 'holders', title: C.steps.holders },
  { id: 'review', title: C.steps.review },
] as const;

export interface ChangeSearch {
  importId?: string | undefined;
  templateId?: string | undefined;
  kind?: ChangeKind | undefined;
}

function Wiz({
  orgId,
  orgName,
  selection,
  initial,
}: {
  orgId: string;
  orgName: string;
  selection: ChangeSelection;
  initial: ChangeKind;
}) {
  const navigate = useNavigate();
  const w = useChangeWizard(orgId, selection, initial);
  const [showErrors, setShowErrors] = useState(false);
  const { step, kind } = w;
  const skipHolders = kind === 'void';
  const lastStep = STEPS.length - 1;
  const p = w.preview.data;
  const will = p ? willChange(p) : 0;
  const needsText = w.notify && kind === 'fields' && w.message.trim() === '';
  const loading = w.details.some((d) => d.isPending);
  const failed = w.details.find((d) => d.isError);
  const toList = () => void navigate({ href: orgPath(orgId, '/passes') });

  if (failed?.error)
    return (
      <ErrorState subject="the template" error={failed.error} onRetry={() => failed.refetch()} />
    );
  if (loading) return <Skeleton className="h-64" />;

  const go = (to: number) => w.setStep(to);
  const next = () => {
    if (step === 0) {
      if (kind === 'fields' && !w.patch) {
        setShowErrors(true);
        return false;
      }
      go(skipHolders ? 2 : 1);
    } else if (step === 1) {
      if (needsText || !w.whenOk) return false;
      go(2);
    } else if (p) void w.submit(p.targeted);
    return undefined;
  };
  const stepsHint =
    step === 1 && needsText
      ? C.holders.needMessage
      : step === 2 && p && will === 0
        ? C.review.nothing
        : undefined;
  return (
    <>
      <Wizard
        steps={STEPS}
        current={step}
        skipped={skipHolders ? ['holders'] : []}
        onStep={go}
        onCancel={toList}
        {...(step > 0 ? { onBack: () => go(step === 2 && skipHolders ? 0 : step - 1) } : {})}
        onNext={next}
        nextLabel={step === lastStep ? C.review.run(will) : 'Next'}
        nextDisabled={step === lastStep && (!p || will === 0 || w.preview.isFetching)}
        {...(stepsHint ? { nextHint: stepsHint } : {})}
        busy={w.submitting}
        asideLabel="Before and after"
        aside={
          step < 2 ? (
            <BeforeAfter
              preview={p}
              waiting={w.patch !== null}
              empty="Pick what changes to see a pass."
            />
          ) : undefined
        }
      >
        {step === 0 ? <ChangeStep w={w} showErrors={showErrors} /> : null}
        {step === 1 ? (
          <HoldersStep
            w={w}
            org={{ id: orgId, name: orgName }}
            error={needsText ? C.holders.needMessage : undefined}
          />
        ) : null}
        {step === 2 ? <ReviewStep w={w} orgName={orgName} /> : null}
        {w.refusal ? (
          <Callout
            tone="danger"
            actions={
              <Button size="sm" variant="outline" onClick={() => w.setRefusal(null)}>
                Dismiss
              </Button>
            }
          >
            {w.refusal}
          </Callout>
        ) : null}
      </Wizard>
      <ConfirmDialog
        open={w.drift !== null}
        onOpenChange={(open) => !open && w.setDrift(null)}
        title={C.confirm.title}
        description={C.confirm.body(w.drift ?? 0)}
        confirmLabel={C.confirm.confirm}
        cancelLabel={C.confirm.cancel}
        confirmDisabled={(w.drift ?? 0) === 0}
        onConfirm={async () => {
          const now = w.drift ?? 0;
          w.setDrift(null);
          await w.submit(now);
        }}
      />
    </>
  );
}

/** The change wizard: Change, Tell holders, Review. The run page takes over from there. */
export function ChangePage({ search }: { search: ChangeSearch }) {
  const scope = useOrgScope();
  const orgId = !scope.isLoading && !scope.isError ? scope.orgId : undefined;
  const allowed = canChangePasses(scope.membership?.capabilities);
  const imported = useImport(search.importId ?? '', search.importId ? orgId : undefined);
  const handed = useMemo(() => (orgId ? takeSelection(orgId) : undefined), [orgId]);
  const selection: ChangeSelection | undefined =
    handed ??
    (search.templateId
      ? { kind: 'template', templateId: search.templateId }
      : imported.data
        ? { kind: 'import', importId: imported.data.id, templateIds: [imported.data.templateId] }
        : undefined);
  const header = (
    <PageHeader
      title={C.title}
      breadcrumbs={[
        { label: 'Passes', to: orgId ? orgPath(orgId, '/passes') : '/admin/passes' },
        { label: 'Change' },
      ]}
    />
  );
  let body: React.ReactNode;
  if (scope.isLoading) body = <Skeleton className="h-64" />;
  else if (scope.isError)
    body = <ErrorState subject="organization access" error={scope.error} onRetry={scope.refetch} />;
  else if (!orgId) body = <EmptyState art="building" title="Choose an organization" />;
  else if (!allowed) return <ForbiddenPage />;
  else if (search.importId && imported.isError)
    body = (
      <ErrorState subject="the import" error={imported.error} onRetry={() => imported.refetch()} />
    );
  else if (search.importId && !selection) body = <Skeleton className="h-64" />;
  else if (!selection)
    body = (
      <EmptyState
        art="people"
        title={C.noSelection}
        action={
          <Button asChild variant="outline">
            <Link to={orgPath(orgId, '/passes')}>{C.toList}</Link>
          </Button>
        }
      />
    );
  else
    body = (
      <Wiz
        key={JSON.stringify(selection)}
        orgId={orgId}
        orgName={scope.membership?.orgName ?? 'Organization'}
        selection={selection}
        initial={search.kind ?? 'fields'}
      />
    );
  return (
    <>
      {header}
      {body}
    </>
  );
}
