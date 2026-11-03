import { Ban, Clock, History } from 'lucide-react';
import type { ReactNode } from 'react';
import type { PassView } from '@/shared/pass-view/index.ts';
import { type AddDirection, addDirection } from '../../shared/add-direction.ts';
import { Breadcrumbs, Buddy, StatusPill } from '../ui/index.ts';
import type { Explore } from './add/direction-view.tsx';
import { passHeading } from './add/heading.ts';
import { updatedLine } from './pass-fields.ts';
import type { MyPass } from './pass-view.ts';

/** `?add=a|b|c` in a dev build: an exploration of the pass page (shared/add-direction.ts). */
export const portalDirection = (): AddDirection | null =>
  addDirection(window.location.search, import.meta.env.DEV);

type State = 'active' | 'voided' | 'expired';

/**
 * a, b: a pass that cannot be added as a pill (Voided, Expired), then the last update. In Apple
 * Wallet is the add block's own line, so the header does not say it twice.
 */
function Pills({ pass, state }: { pass: MyPass; state: State }) {
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

function Item({ icon, tone, children }: { icon: ReactNode; tone?: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5 [&_svg]:size-4">
      <span className={tone ?? 'text-fg-muted'}>{icon}</span>
      {children}
    </span>
  );
}

/** c: the same facts as plain lines led by their icons, no chrome around them. */
function Lines({ pass, state }: { pass: MyPass; state: State }) {
  return (
    <>
      {state === 'voided' ? (
        <Item icon={<Ban aria-hidden />}>Voided</Item>
      ) : state === 'expired' ? (
        <Item icon={<Clock aria-hidden />} tone="text-warning">
          Expired
        </Item>
      ) : null}
      <Item icon={<History aria-hidden />}>{updatedLine(pass.modifiedAt)}</Item>
    </>
  );
}

/** The exploration's header and add block for the portal's pass (holder-pass-view.tsx). */
export function exploreOf(
  direction: AddDirection,
  pass: MyPass,
  view: PassView,
  state: State,
  fallback: string,
): Explore {
  const heading = passHeading(view.description, [view.organizationName, pass.orgName], fallback);
  return {
    direction,
    heading,
    view,
    crumbs: <Breadcrumbs items={[{ label: 'My passes', to: '/' }, { label: heading.title }]} />,
    meta:
      direction === 'c' ? <Lines pass={pass} state={state} /> : <Pills pass={pass} state={state} />,
    inWallet: pass.inWallet,
    buddy: (props) => <Buddy {...props} />,
  };
}
