import { BadgeCheck, ShieldCheck } from 'lucide-react';
import { Fragment, useState } from 'react';
import type { PassSetup } from '@/shared/contracts/pass-setup.ts';
import { PASS_SETUP_COPY } from '@/shared/copy/pass-setup.ts';
import { scanLine } from '@/shared/copy/scan.ts';
import { cn } from '@/web/lib/cn.ts';
import { formatDay } from '@/web/lib/format.ts';
import { Button } from '@/web/ui/index.ts';
import { NewManagedIdentityDialog } from '../wallet-accounts/apple/new-managed-dialog.tsx';
import { OrgAppleHistory } from '../wallet-accounts/org-apple-history.tsx';
import './brand.css';
import { RunSteps, stepIndex } from './run-steps.tsx';

const COPY = PASS_SETUP_COPY.channelsCard;
const KINDS = PASS_SETUP_COPY.identityKinds;
const ACTIVE = new Set(['queued', 'running', 'waiting']);

/** An identifier that wraps only after a dot, never inside a part. */
const breakAtDots = (id: string) =>
  id.split('.').map((part, i, all) => (
    <Fragment key={all.slice(0, i + 1).join('.')}>
      {part}
      {i < all.length - 1 ? '.' : null}
      {i < all.length - 1 ? <wbr /> : null}
    </Fragment>
  ));

/** What the Apple row signs with: the shared ID, a run in progress, or the org's own managed ID. */
export function AppleIdentity({
  orgId,
  apple,
  canManage,
}: {
  orgId: string;
  apple: PassSetup['apple'];
  canManage: boolean;
}) {
  const [creating, setCreating] = useState(false);
  const [history, setHistory] = useState(false);
  const { identity, run } = apple;
  const running = run && ACTIVE.has(run.state);
  const failed = run?.state === 'failed';
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-xs font-semibold text-fg-muted">{COPY.signedAs}</h3>
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-surface-sunken p-3">
        <span
          aria-hidden
          className={cn(
            'inline-flex size-9 shrink-0 items-center justify-center rounded-full border border-border-strong text-fg-muted',
            identity && 'bc-stamp border-success-border bg-success-subtle text-success',
          )}
        >
          {identity ? <BadgeCheck className="size-5" /> : <ShieldCheck className="size-5" />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="break-normal font-mono text-sm text-fg-strong">
            {breakAtDots(identity?.identifier ?? apple.sharedIdentifier)}
          </p>
          <p className="text-xs text-fg-muted">
            {identity ? KINDS[identity.kind] : KINDS.platform}
            {identity ? null : " · PassBook's ID"}
            {identity?.notAfter
              ? ` · ${scanLine(COPY.renews, { date: formatDay(identity.notAfter) })}`
              : ''}
            {identity ? ` · ${COPY.push[apple.push]}` : ''}
            {identity && apple.passesOnShared > 0
              ? ` · ${scanLine(COPY.olderPasses, { n: apple.passesOnShared })}`
              : ''}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {identity ? (
            <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>
              {COPY.history}
            </Button>
          ) : apple.managedAllowed && canManage && !running ? (
            <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
              {PASS_SETUP_COPY.fixes.start_apple_managed}
            </Button>
          ) : null}
        </div>
      </div>
      {running || failed ? (
        <RunSteps labels={COPY.runSteps} at={stepIndex(run?.step ?? null)} failed={failed} />
      ) : null}
      <NewManagedIdentityDialog open={creating} onOpenChange={setCreating} orgId={orgId} />
      <OrgAppleHistory
        orgId={orgId}
        identityId={identity?.id}
        identifier={identity?.identifier ?? apple.sharedIdentifier}
        open={history}
        onOpenChange={setHistory}
      />
    </div>
  );
}
