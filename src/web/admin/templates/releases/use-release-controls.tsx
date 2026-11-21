import { lazy, Suspense, useState } from 'react';
import { toast } from '../../../ui/index.ts';
import { useReleaseFlow } from './flow-api.ts';

const ReleaseFlowDialog = lazy(() => import('./release-flow-dialog.tsx'));
const ReviewDialog = lazy(() => import('./review-dialog.tsx'));

/** Try (Test only, one call) and the Release dialog, for the strip, the header and Saved versions. */
export function useReleaseControls(
  templateId: string,
  orgId: string | undefined,
  name: (hash: string | null) => string,
  /** Set where a reviewer can open the review in place (the designer's header). */
  review?: { canPublish: boolean; requestedBy: string | null },
) {
  const [releasing, setReleasing] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<string | null>(null);
  const flow = useReleaseFlow(templateId, orgId ?? '');
  async function tryVersion(version: string) {
    try {
      await flow.mutateAsync({ version, modes: ['test'] });
      toast.success(`${name(version)} is in Test`);
    } catch (cause) {
      toast.error(cause, `Could not try ${name(version)}`);
    }
  }
  return {
    tryVersion,
    trying: flow.isPending,
    release: setReleasing,
    startReview: setReviewing,
    dialog: orgId ? (
      <>
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
              onClose={() => setReviewing(null)}
            />
          </Suspense>
        ) : null}
      </>
    ) : null,
  };
}
