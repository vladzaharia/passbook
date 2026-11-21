import { Mail, WalletCards } from 'lucide-react';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import { buttonVariants } from '../ui/button-variants.ts';
import type { HolderSupport } from './holder-parts.tsx';

/** /p: "Email me my passes" posts here; `state` is the answer the redirect carried. */
export interface EndedSignIn {
  action: string;
  state: 'sent' | 'wait' | null;
}

const BTN = 'w-full sm:w-auto';

/**
 * A voided, expired or removed pass: one sentence, then the way on. The org's contact leads when
 * it has one; "Email me my passes" is always there when the page can send it (never naming the
 * address). With neither, the sentence asks the org for a new pass. One card for the portal and /p.
 */
export function EndedCard({
  state,
  orgName,
  support,
  message,
  endedOn,
  signin,
}: {
  state: 'voided' | 'expired' | 'removed';
  orgName: string;
  support?: HolderSupport | null | undefined;
  /** The org's note with a removal. */
  message?: string | null | undefined;
  /** When it stopped working, already formatted. */
  endedOn?: string | null | undefined;
  signin?: EndedSignIn | undefined;
}) {
  // PassBook's own inbox is never offered on an org's page.
  const own = support && !support.platform ? support : null;
  const href = state === 'removed' ? undefined : own?.email ? `mailto:${own.email}` : own?.url;
  const sentence =
    state === 'voided'
      ? endedOn
        ? HOLDER_COPY.voidedOn(endedOn)
        : HOLDER_COPY.voided
      : state === 'expired'
        ? endedOn
          ? HOLDER_COPY.expiredOn(endedOn)
          : HOLDER_COPY.expired
        : HOLDER_COPY.removedPlain;
  const contact = href ? (
    <a href={href} className={`${buttonVariants({ variant: 'primary', size: 'lg' })} ${BTN}`}>
      <Mail aria-hidden />
      {HOLDER_COPY.contact(orgName)}
    </a>
  ) : null;
  const mine = signin ? (
    signin.state ? (
      <p className="text-sm font-medium text-fg-strong">
        {signin.state === 'sent' ? HOLDER_COPY.sendAgainSent : HOLDER_COPY.sendAgainWait}
      </p>
    ) : (
      <form method="post" action={signin.action}>
        <button
          type="submit"
          className={`${buttonVariants({ variant: contact ? 'outline' : 'primary', size: 'lg' })} ${BTN}`}
        >
          <WalletCards aria-hidden />
          {HOLDER_COPY.emailMyPasses}
        </button>
      </form>
    )
  ) : null;
  return (
    <div role="status" className="rounded-lg border border-border bg-surface-raised p-4 text-sm">
      <p className="max-w-[65ch] text-fg-strong">{sentence}</p>
      {state === 'removed' && message ? (
        <p className="mt-1 max-w-[65ch] text-fg [overflow-wrap:anywhere]">{message}</p>
      ) : null}
      {contact || mine ? (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          {contact}
          {mine}
        </div>
      ) : (
        <p className="mt-1 max-w-[65ch] text-fg">{HOLDER_COPY.askForNew(orgName)}</p>
      )}
    </div>
  );
}
