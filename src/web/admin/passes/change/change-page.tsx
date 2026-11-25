import { Link, useNavigate } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import { OrgChooser } from '@/web/ui/layout/org-chooser.tsx';
import { voidConfirm } from '../../../lib/confirms.ts';
import { selectionMovedConfirm } from '../../../lib/confirms-change.ts';
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
import { exactNothing, ReviewStep } from './review-step.tsx';
import { type ChangeSelection, canChangePasses, takeSelection, targetOf } from './selection.ts';
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
  /** Opened from Tell holders: Notify starts on. */
  tell?: boolean | undefined;
}

/** Which passes, in a line: the source the run reads, so the person can see what it will touch. */
function whichOf(selection: ChangeSelection, templateName: string): string {
  if (selection.kind === 'ids') return C.which.ids(selection.ids.length);
  if (selection.kind === 'import') return C.which.import(selection.count);
  if (selection.kind === 'template') return C.which.template(templateName);
  return C.which.filter(selection.count, templateName);
}

function Wiz({
  orgId,
  orgName,
  selection,
  initial,
  tell,
}: {
  orgId: string;
  orgName: string;
  selection: ChangeSelection;
  initial: ChangeKind;
  tell: boolean;
}) {
  const navigate = useNavigate();
  const w = useChangeWizard(orgId, selection, initial, tell);
  const [showErrors, setShowErrors] = useState(false);
  const [holderAttempt, setHolderAttempt] = useState(false);
  const [askVoid, setAskVoid] = useState(false);
  const { step, kind } = w;
  const skipHolders = kind === 'void';
  const lastStep = STEPS.length - 1;
  const p = w.preview.data;
  const targeted = p?.targeted ?? 0;
  const needsText = w.notify && kind === 'fields' && w.message.trim() === '';
  const loading = w.details.some((d) => d.isPending);
  const failed = w.details.find((d) => d.isError);
  const toList = () => void navigate({ href: orgPath(orgId, '/passes') });
  const which = whichOf(selection, w.details[0]?.data?.name ?? 'the template');

  if (failed?.error)
    return (
      <ErrorState subject="the template" error={failed.error} onRetry={() => failed.refetch()} />
    );
  if (loading) return <Skeleton className="h-64" />;
  // The create was rate limited. This is the kit's error card, in the viewport, with the wait; the
  // wizard (its step, fields and selection) is only hidden, and Retry sends the same call again.
  if (w.limited && w.refusal)
    return (
      <ErrorState
        title={w.refusal}
        error={w.limited}
        onRetry={() => (p ? w.submit(p.targeted) : undefined)}
        action={
          <Button variant="outline" onClick={() => w.setLimited(null)}>
            Back to review
          </Button>
        }
      />
    );

  const go = (to: number) => w.setStep(to);
  /** The count the person selected is the one the run takes: a different one is confirmed first. */
  const run = () => {
    if (!p) return;
    // Only a count that went up is news: a smaller one reads "N of M can change" on Review.
    if (selection.kind === 'filter' && p.targeted > selection.count) w.setDrift(p.targeted);
    else void w.submit(p.targeted);
  };
  const next = () => {
    if (step === 0) {
      if (kind === 'fields' && !w.patch) {
        setShowErrors(true);
        return false;
      }
      go(skipHolders ? 2 : 1);
    } else if (step === 1) {
      setHolderAttempt(true);
      if (needsText || !w.whenOk) return false;
      go(2);
    } else if (kind === 'void') setAskVoid(true);
    else run();
    return undefined;
  };
  const reviewing = step === lastStep;
  const hint = reviewing
    ? !p || !w.fresh
      ? C.review.checking
      : targeted === 0
        ? C.review.nothing
        : undefined
    : step === 1 && !w.whenOk
      ? C.holders.needTime
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
        nextLabel={
          reviewing ? (kind === 'void' ? C.review.void(targeted) : C.review.run(targeted)) : 'Next'
        }
        {...(reviewing && kind === 'void' ? { nextTone: 'danger' as const } : {})}
        nextDisabled={
          (reviewing && (!p || !w.fresh || targeted === 0 || (p && exactNothing(p)))) ||
          (step === 1 && !w.whenOk)
        }
        {...(hint ? { nextHint: hint } : {})}
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
        {step === 0 ? <ChangeStep w={w} which={which} showErrors={showErrors} /> : null}
        {step === 1 ? (
          <HoldersStep
            w={w}
            org={{ id: orgId, name: orgName }}
            error={holderAttempt && needsText ? C.holders.needMessage : undefined}
          />
        ) : null}
        {step === 2 ? (
          <ReviewStep
            w={w}
            which={which}
            picked={selection.kind === 'filter' ? selection.count : undefined}
          />
        ) : null}
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
        {...selectionMovedConfirm(w.drift ?? 0)}
        confirmDisabled={(w.drift ?? 0) === 0}
        onConfirm={async () => {
          const now = w.drift ?? 0;
          w.setDrift(null);
          await w.submit(now);
        }}
      />
      <ConfirmDialog
        open={askVoid}
        onOpenChange={setAskVoid}
        {...voidConfirm(targeted)}
        destructive
        onConfirm={() => {
          setAskVoid(false);
          run();
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
  // An entry point's own target wins: a list hand-off left in the tab never replaces it.
  const explicit = Boolean(search.importId || search.templateId);
  const handed = useMemo(
    () => (orgId && !explicit ? takeSelection(orgId) : undefined),
    [orgId, explicit],
  );
  const candidate: ChangeSelection | undefined =
    handed ??
    (search.templateId
      ? { kind: 'template', templateId: search.templateId }
      : imported.data
        ? {
            kind: 'import',
            importId: imported.data.id,
            templateIds: [imported.data.templateId],
            ...(imported.data.counts
              ? { count: imported.data.counts.create + imported.data.counts.update }
              : {}),
          }
        : undefined);
  // A filter a run cannot take is refused, never widened to the template.
  const selection = candidate && targetOf(candidate) === null ? undefined : candidate;
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
  else if (!orgId) return <OrgChooser />;
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
        tell={search.tell === true}
      />
    );
  return (
    <>
      {header}
      {body}
    </>
  );
}
