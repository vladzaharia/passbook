import { Ban, Clock, EyeOff } from 'lucide-react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { Callout } from '../ui/callout.tsx';

/** The org's support contacts, already checked (public/service.ts supportContacts). */
export interface HolderSupport {
  email: string | null;
  url: string | null;
  /** PassBook's own support, because the org has none. */
  platform?: true | undefined;
}

const LINK = 'font-medium text-accent-fg underline-offset-4 hover:underline';

/** Voided, removed or expired, one line; a voided pass names the org so it is not a dead end. */
export function Notice({
  state,
  orgName,
  support,
  message,
  many,
}: {
  state: 'active' | 'voided' | 'expired' | 'removed';
  orgName: string;
  support?: HolderSupport | null | undefined;
  /** The org's note with a removal. */
  message?: string | null | undefined;
  /** A bundle: every pass in it. */
  many?: boolean;
}) {
  if (state === 'active') return null;
  const voided = state === 'voided';
  // PassBook's own inbox is never offered on an org's page.
  const own = support && !support.platform ? support : null;
  const href = own?.email ? `mailto:${own.email}` : own?.url;
  return (
    <div role="status">
      <Callout tone="warning" icon={voided ? Ban : state === 'removed' ? EyeOff : Clock}>
        {voided
          ? many
            ? HOLDER_COPY.voidedMany
            : HOLDER_COPY.voided
          : state === 'removed'
            ? HOLDER_COPY.removed
            : HOLDER_COPY.expired}
        {voided ? (
          <>
            {' '}
            {href ? (
              <a href={href} className={LINK}>
                {HOLDER_COPY.contact(orgName)}
              </a>
            ) : (
              HOLDER_COPY.askForNew(orgName)
            )}
          </>
        ) : null}
        {state === 'removed' && message ? (
          <span className="mt-1 block [overflow-wrap:anywhere]">{message}</span>
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
