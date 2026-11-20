import { PREVIEW_COPY, walletName } from '@/shared/copy/previews.ts';
import { Badge, Callout, EmptyState, Skeleton } from '../ui/index.ts';
import { GoogleCard } from '../wallet-previews/google/google-card.tsx';
import { SamsungCard } from '../wallet-previews/samsung/samsung-card.tsx';
import { FidelityNotes } from './fidelity-notes.tsx';
import type { WalletPreviews } from './use-wallet-previews.ts';

/** One wallet's card beside its fidelity report; the report stands alone when there is no card. */
export function WalletChannel({
  target,
  previews,
  testBand,
}: {
  target: 'google' | 'samsung';
  previews: WalletPreviews;
  /** A sandbox pass: the TEST PREVIEW band on the card. */
  testBand?: boolean | undefined;
}) {
  const wallet = walletName(target);
  if (previews.state === 'loading')
    return (
      <div role="status" aria-label={PREVIEW_COPY.loading}>
        <Skeleton className="mx-auto aspect-[320/420] w-full max-w-xs rounded-xl" />
      </div>
    );
  if (previews.state === 'error')
    return (
      <p role="alert" className="text-sm text-danger">
        {PREVIEW_COPY.failed}
      </p>
    );
  const { compiled, report } = previews.out[target];
  if (compiled.type === 'off')
    return (
      <EmptyState inline art="lock" title={PREVIEW_COPY.walletOff.replace('{wallet}', wallet)} />
    );
  const card =
    target === 'samsung' ? (
      compiled.cardData ? (
        <SamsungCard
          data={compiled.cardData as Parameters<typeof SamsungCard>[0]['data']}
          testBand={testBand}
        />
      ) : null
    ) : compiled.objectBody ? (
      <GoogleCard
        type={compiled.type}
        classBody={compiled.classBody}
        objectBody={compiled.objectBody}
        testBand={testBand}
      />
    ) : null;
  return (
    <div className="wp-wrap w-full" data-testid={`${target}-channel`}>
      <div className="wp-split">
        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="neutral">{PREVIEW_COPY.badge}</Badge>
            <span className="text-xs text-fg-muted">
              {PREVIEW_COPY.approximate.replace('{wallet}', wallet)}
            </span>
          </div>
          {compiled.blocked ? (
            <Callout tone="warning" title={PREVIEW_COPY.blocked.replace('{wallet}', wallet)}>
              {compiled.blocked.message}
            </Callout>
          ) : (
            card
          )}
        </div>
        <FidelityNotes report={report} />
      </div>
    </div>
  );
}
