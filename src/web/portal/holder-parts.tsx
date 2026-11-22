import { Ban, Clock, EyeOff, Mail } from 'lucide-react';
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
  endedOn,
  inWallet,
  mixed,
}: {
  state: 'active' | 'voided' | 'expired' | 'removed';
  orgName: string;
  support?: HolderSupport | null | undefined;
  /** The org's note with a removal. */
  message?: string | null | undefined;
  /** A bundle: every pass in it. */
  many?: boolean;
  /** A bundle with voided and removed passes together: neither word is true of all. */
  mixed?: boolean;
  /** When it stopped working, already formatted. */
  endedOn?: string | null | undefined;
  /** Known not to be in a Wallet (the portal knows; /p does not): no Wallet jargon then. */
  inWallet?: boolean | undefined;
}) {
  if (state === 'active') return null;
  const voided = state === 'voided';
  // PassBook's own inbox is never offered on an org's page.
  const own = support && !support.platform ? support : null;
  const href = own?.email ? `mailto:${own.email}` : own?.url;
  return (
    <div role="status">
      <Callout tone="warning" icon={voided ? Ban : state === 'removed' ? EyeOff : Clock}>
        {mixed
          ? HOLDER_COPY.endedMany
          : voided
            ? many
              ? HOLDER_COPY.voidedMany
              : endedOn
                ? HOLDER_COPY.voidedOn(endedOn)
                : HOLDER_COPY.voided
            : state === 'removed'
              ? many
                ? HOLDER_COPY.removedMany
                : inWallet === false
                  ? HOLDER_COPY.removedPlain
                  : HOLDER_COPY.removed
              : endedOn
                ? HOLDER_COPY.expiredOn(endedOn)
                : HOLDER_COPY.expired}
        {mixed || voided || state === 'expired' ? (
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

/** Pass page: mail the pass to its holder again, a row of the other ways. A plain form, so it
 * works without script. */
export function SendAgain({
  action,
  again,
}: {
  action: string;
  again: 'sent' | 'wait' | null | undefined;
}) {
  return (
    <>
      <form method="post" action={action}>
        <button type="submit" className="wl-other">
          <Mail aria-hidden />
          <span>{HOLDER_COPY.emailPassAgain}</span>
        </button>
      </form>
      {again ? (
        <p role="status" className="wl-other-status">
          {again === 'sent' ? HOLDER_COPY.sendAgainSent : HOLDER_COPY.sendAgainWait}
        </p>
      ) : null}
    </>
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
