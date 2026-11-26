import type { ReactNode } from 'react';
import { PREVIEW_COPY, walletName } from '@/shared/copy/previews.ts';
import { WALLETS_COPY } from '@/shared/copy/wallets.ts';
import { Callout } from '../ui/callout.tsx';
import { EmptyState } from '../ui/empty-state.tsx';
import { Skeleton } from '../ui/skeleton.tsx';
import { GoogleCard } from '../wallet-previews/google/google-card.tsx';
import { SamsungCard } from '../wallet-previews/samsung/samsung-card.tsx';
import { WalletReport } from '../wallet-report/wallet-report.tsx';
import { FacePair, type PreviewFace } from './face-pair.tsx';
import type { WalletPreviews } from './use-wallet-previews.ts';

/**
 * One wallet's card, front and back (FacePair), beside its fidelity report. A page that lists what
 * each wallet drops elsewhere passes `notes={false}`.
 */
export function WalletChannel({
  target,
  previews,
  testBand,
  notes = true,
  face,
  onFace,
  fit,
  action,
}: {
  target: 'google' | 'samsung';
  previews: WalletPreviews;
  /** A sandbox pass: the TEST PREVIEW band on the card. */
  testBand?: boolean | undefined;
  /** The fidelity report beside the card. */
  notes?: boolean | undefined;
  face?: PreviewFace | undefined;
  onFace?: ((face: PreviewFace) => void) | undefined;
  /** Size the frame to the face shown (the Wallets tab). */
  fit?: boolean | undefined;
  /** A link out of the report: Edit in Wallets, where the page has that tab. */
  action?: ReactNode;
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
  const cardOf = (side: PreviewFace) =>
    target === 'samsung' ? (
      compiled.cardData ? (
        <SamsungCard
          data={compiled.cardData as Parameters<typeof SamsungCard>[0]['data']}
          testBand={testBand}
          face={side}
        />
      ) : null
    ) : compiled.objectBody ? (
      <GoogleCard
        type={compiled.type}
        classBody={compiled.classBody}
        objectBody={compiled.objectBody}
        testBand={testBand}
        face={side}
      />
    ) : null;
  // The report beside the card already says why; alone, the card's place says it.
  const card = compiled.blocked ? (
    notes ? (
      <div className="wm-blocked-card wl-hatch">{WALLETS_COPY.report.noPreview}</div>
    ) : (
      <Callout tone="warning" title={PREVIEW_COPY.blocked.replace('{wallet}', wallet)}>
        {compiled.blocked.message}
      </Callout>
    )
  ) : (
    <FacePair front={cardOf('front')} back={cardOf('back')} face={face} onFace={onFace} fit={fit} />
  );
  return (
    <div className="wp-wrap w-full" data-testid={`${target}-channel`}>
      {notes ? (
        <div className="wp-split">
          <div className="min-w-0">{card}</div>
          <WalletReport report={report} host="pane" footerAction={action} />
        </div>
      ) : (
        card
      )}
    </div>
  );
}
