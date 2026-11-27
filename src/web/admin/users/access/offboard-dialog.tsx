import type { OffboardPlan } from '@/shared/contracts/idp-access.ts';
import { offboardConfirm } from '@/web/lib/confirms-idp.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Callout, Skeleton, TypedConfirmDialog } from '@/web/ui/index.ts';
import { planLines } from './offboard-plan.ts';

/** The dry-run plan, then the word to type, then the run. Confirming is off while an org would lose its last admin. */
export function OffboardDialog({
  open,
  onOpenChange,
  name,
  plan,
  loading,
  loadError,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  plan: OffboardPlan | undefined;
  loading: boolean;
  loadError: unknown;
  onConfirm: () => Promise<unknown>;
}) {
  const { word, title, confirmLabel } = offboardConfirm(name);
  const blockers = plan?.blockers ?? [];
  return (
    <TypedConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      word={word}
      confirmLabel={confirmLabel}
      blocked={!plan || blockers.length > 0}
      onConfirm={onConfirm}
    >
      {loading ? (
        <div role="status" aria-label="Reading the plan" className="flex flex-col gap-2">
          <Skeleton className="h-4 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : loadError ? (
        <Callout tone="danger">{errorMessage(loadError)}</Callout>
      ) : plan ? (
        <div className="flex flex-col gap-4">
          {blockers.length ? (
            <Callout tone="danger">
              {blockers.map((b) => `${b.org.name} would lose its last admin.`).join(' ')}
            </Callout>
          ) : null}
          <ul className="list-disc pl-5 text-sm text-fg">
            {planLines(plan).map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </TypedConfirmDialog>
  );
}
