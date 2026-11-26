import { useState } from 'react';
import type { Mode } from '@/shared/contracts/common.ts';
import type { WalletProvider } from '@/shared/contracts/wallet-providers.ts';
import type { EnableReadyResult } from '@/shared/contracts/wallet-release.ts';
import { enableReadyConfirm } from '@/web/lib/confirms-wallet.ts';
import { pluralize } from '@/web/lib/format.ts';
import { isStepUp } from '@/web/lib/step-up.ts';
import { Button, ConfirmDialog, EmptyState, toast } from '@/web/ui/index.ts';
import { PROVIDER_NAME, safeError } from './copy.ts';
import { useEnableReady } from './queries.ts';
import { isReadyChanged, PARTIAL, RELEASE_COPY } from './release-copy.ts';

type Org = EnableReadyResult['enrolments'][number];

const names = (orgs: Org[]) => orgs.map((o) => o.orgName).join(', ');

/** What the list gained and lost between the reviewed dry run and now. */
function diffLine(before: Org[], after: Org[]): string {
  const had = new Set(before.map((o) => o.orgId));
  const has = new Set(after.map((o) => o.orgId));
  const added = after.filter((o) => !had.has(o.orgId));
  const gone = before.filter((o) => !has.has(o.orgId));
  const parts = [
    added.length ? `Now ready: ${names(added)}.` : '',
    gone.length ? `No longer ready: ${names(gone)}.` : '',
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : RELEASE_COPY.changed;
}

/**
 * The enable-ready dry run for one provider and mode. Apply sends the dry run's exact `orgIds`;
 * a changed list (409) says what changed and offers the dry run again. Step-up is the kit's: the
 * api layer opens its dialog and the person clicks again once signed in.
 */
export function ReleaseApply({
  provider,
  mode,
  modeLabel,
  released,
}: {
  provider: WalletProvider;
  mode: Mode;
  modeLabel: string;
  released: boolean;
}) {
  const actions = useEnableReady();
  const [dry, setDry] = useState<EnableReadyResult>();
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setProblem(null);
    try {
      setDry(await actions.dryRun(provider, mode));
    } catch (cause) {
      if (!isStepUp(cause)) toast.error(safeError(cause), 'Could not run the dry run');
    } finally {
      setBusy(false);
    }
  }

  async function apply(reviewed: Org[]) {
    try {
      const result = await actions.apply(
        provider,
        mode,
        reviewed.map((o) => o.orgId),
      );
      setDry(undefined);
      toast.success(`Turned on ${pluralize(result.enrolments.length, 'account')}`);
    } catch (cause) {
      if (isStepUp(cause)) return;
      setDry(undefined);
      if (!isReadyChanged(cause)) {
        setProblem(`${safeError(cause)} ${PARTIAL}`);
        return;
      }
      // The list the person reviewed is gone: read the new one once to say what moved.
      try {
        setProblem(diffLine(reviewed, (await actions.dryRun(provider, mode)).enrolments));
      } catch {
        setProblem(RELEASE_COPY.changed);
      }
    }
  }

  const ready = dry?.enrolments ?? [];
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm" variant="outline" loading={busy} onClick={() => void run()}>
          {dry ? 'Run again' : RELEASE_COPY.dryRun}
        </Button>
        {dry ? null : <span className="text-xs text-fg-muted">{RELEASE_COPY.dryRunNote}</span>}
      </div>
      {problem ? (
        <div role="alert" className="flex flex-col items-start gap-2 text-sm text-danger">
          <p>{problem}</p>
          <Button size="sm" variant="outline" loading={busy} onClick={() => void run()}>
            {RELEASE_COPY.runAgain}
          </Button>
        </div>
      ) : null}
      {dry && ready.length === 0 ? (
        <EmptyState inline art="wallet" title={RELEASE_COPY.nothingReady} />
      ) : null}
      {dry && ready.length > 0 ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-fg-strong">
            Would turn on {pluralize(ready.length, 'account')}
          </p>
          <ul aria-label="Dry run" className="list-disc pl-5 text-sm text-fg-muted">
            {ready.map((o) => (
              <li key={o.orgId}>{o.orgName}</li>
            ))}
          </ul>
          {released ? (
            <div>
              <Button size="sm" onClick={() => setConfirming(true)}>
                {RELEASE_COPY.apply}
              </Button>
            </div>
          ) : (
            <p className="text-xs text-fg-muted">{RELEASE_COPY.wouldOnceReleased}</p>
          )}
          <ConfirmDialog
            open={confirming}
            onOpenChange={setConfirming}
            {...enableReadyConfirm(PROVIDER_NAME[provider], modeLabel, ready.length)}
            onConfirm={() => apply(ready)}
          />
        </div>
      ) : null}
    </div>
  );
}
