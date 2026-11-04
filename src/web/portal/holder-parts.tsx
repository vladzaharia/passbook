import { Ban, Clock } from 'lucide-react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { Callout } from '../ui/callout.tsx';

/** The org's support contacts, already checked (public/service.ts supportContacts). */
export interface HolderSupport {
  email: string | null;
  url: string | null;
}

const LINK = 'font-medium text-accent-fg underline-offset-4 hover:underline';

/** Voided or expired, one line; a voided pass names the org's support so it is not a dead end. */
export function Notice({
  state,
  orgName,
  support,
}: {
  state: 'active' | 'voided' | 'expired';
  orgName: string;
  support?: HolderSupport | null | undefined;
}) {
  if (state === 'active') return null;
  const voided = state === 'voided';
  const href = support?.email ? `mailto:${support.email}` : support?.url;
  return (
    <div role="status">
      <Callout tone="warning" icon={voided ? Ban : Clock}>
        {voided ? HOLDER_COPY.voided : HOLDER_COPY.expired}
        {voided && href ? (
          <>
            {' '}
            <a href={href} className={LINK}>
              {HOLDER_COPY.contact(orgName)}
            </a>
          </>
        ) : null}
      </Callout>
    </div>
  );
}

/** The org's support contacts while the pass is live (the voided note carries its own). */
export function Help({ support }: { support: HolderSupport }) {
  return (
    <p className="text-sm text-fg-muted [overflow-wrap:anywhere]">
      {HOLDER_COPY.help}:{' '}
      {support.email ? (
        <a href={`mailto:${support.email}`} className={LINK}>
          {support.email}
        </a>
      ) : null}
      {support.email && support.url ? ' · ' : null}
      {support.url ? (
        <a href={support.url} className={LINK}>
          {support.url}
        </a>
      ) : null}
    </p>
  );
}

/** /p's quiet way to the holder's page: muted until pointed at. Signed out, sign-in comes first. */
export function PortalLink({ href }: { href: string }) {
  return (
    <p className="text-sm">
      <a href={href} className="text-fg-muted underline underline-offset-4 hover:text-fg-strong">
        {HOLDER_COPY.openInPortal}
      </a>
    </p>
  );
}
