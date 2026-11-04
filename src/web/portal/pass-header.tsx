import { useNavigate } from '@tanstack/react-router';
import { Clock } from 'lucide-react';
import type { PassView } from '@/shared/pass-view/index.ts';
import { useDocumentTitle } from '../lib/route-focus.tsx';
import { Breadcrumbs, StatusPill } from '../ui/index.ts';
import { type PassHeading, passHeading } from './add/heading.ts';
import { HolderHeading } from './holder-heading.tsx';
import { updatedLine } from './pass-fields.ts';
import { type HolderState, type MyPass, passName } from './pass-view.ts';
import { RefreshButton } from './refresh-button.tsx';
import { PassMoreMenu, publicUrlOf } from './wallet-actions.tsx';

const LOADING: PassHeading = { title: 'Pass', org: '', kind: null };

export interface PassHeaderProps {
  /** Unset while the pass loads (or failed to): the same header, so the h1 keeps its focus. */
  pass?: MyPass | undefined;
  view?: PassView | null | undefined;
  state?: HolderState;
}

/** A pass that cannot be added says so as a pill; then the last update. */
function Meta({ pass, state }: { pass: MyPass; state: HolderState }) {
  return (
    <>
      {state === 'voided' ? (
        <StatusPill status="voided" />
      ) : state === 'expired' ? (
        <StatusPill status="expired" tone="warning" icon={Clock}>
          Expired
        </StatusPill>
      ) : null}
      <span>{updatedLine(pass.modifiedAt)}</span>
    </>
  );
}

/**
 * The portal's pass header (HolderHeading, shared with /p): what the pass is, its org's mark, the
 * breadcrumbs, and Refresh and More; the tab title is the whole title.
 */
export function PassHeader({ pass, view, state = 'active' }: PassHeaderProps) {
  const navigate = useNavigate();
  const heading =
    pass && view
      ? passHeading(view.description, [view.organizationName, pass.orgName], passName(pass))
      : LOADING;
  useDocumentTitle(heading.title);
  const voided = state === 'voided';
  return (
    <HolderHeading
      heading={heading}
      icon={view?.images.icon}
      crumbs={<Breadcrumbs items={[{ label: 'My passes', to: '/' }, { label: heading.title }]} />}
      meta={pass ? <Meta pass={pass} state={state} /> : undefined}
      actions={
        pass ? (
          <>
            {voided ? null : <RefreshButton passId={pass.id} pass={pass} />}
            <PassMoreMenu
              page
              passId={pass.id}
              passTitle={passName(pass)}
              publicUrl={voided ? null : publicUrlOf(pass.downloadUrl)}
              onRemoved={() => void navigate({ to: '/', replace: true })}
            />
          </>
        ) : undefined
      }
    />
  );
}
