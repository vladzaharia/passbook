import { lazy, Suspense, useState } from 'react';

const TrySheet = lazy(() => import('./try-sheet.tsx'));
const ReleaseFlowDialog = lazy(() => import('./release-flow-dialog.tsx'));
const ReviewDialog = lazy(() => import('./review-dialog.tsx'));

/** Try (the sheet: Test release, a Test pass, a device watch) and the Release dialog, for the strip, the header and the Versions list. */
export function useReleaseControls(
  templateId: string,
  orgId: string | undefined,
  name: (hash: string | null) => string,
  /** Set where a reviewer can open the review in place (the designer's header). */
  review?: {
    canPublish: boolean;
    requestedBy: string | null;
    /** A version opened from outside (the page's `?review=`), and what closing it does. */
    open?: string | undefined;
    onClose?: () => void;
  },
) {
  const [releasing, setReleasing] = useState<string | null>(null);
  const [localReview, setReviewing] = useState<string | null>(null);
  const reviewing = review?.open ?? localReview;
  const [trying, setTrying] = useState<string | null>(null);
  return {
    tryVersion: setTrying,
    release: setReleasing,
    startReview: setReviewing,
    dialog: orgId ? (
      <>
        {trying ? (
          <Suspense fallback={null}>
            <TrySheet
              templateId={templateId}
              orgId={orgId}
              version={trying}
              name={name}
              onClose={() => setTrying(null)}
              onRelease={setReleasing}
            />
          </Suspense>
        ) : null}
        {releasing ? (
          <Suspense fallback={null}>
            <ReleaseFlowDialog
              templateId={templateId}
              orgId={orgId}
              version={releasing}
              name={name}
              onClose={() => setReleasing(null)}
            />
          </Suspense>
        ) : null}
        {reviewing && review ? (
          <Suspense fallback={null}>
            <ReviewDialog
              templateId={templateId}
              orgId={orgId}
              version={reviewing}
              name={name}
              requestedBy={review.requestedBy}
              canPublish={review.canPublish}
              onClose={review.onClose ?? (() => setReviewing(null))}
            />
          </Suspense>
        ) : null}
      </>
    ) : null,
  };
}
