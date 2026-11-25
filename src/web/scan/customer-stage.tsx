import { STAGE, type StageTone } from './customer-tone.ts';
import { CustomerBuddy, type CustomerBuddyStatus } from './live/customer-buddy.tsx';
import { figureSlots } from './live/customer-draft.ts';
import { ScanOrgLogo } from './platform/scan-branding.tsx';
import './customer-display.css';

const BUDDY: Record<StageTone, CustomerBuddyStatus> = {
  ready: 'ready',
  checking: 'checking',
  accepted: 'accepted',
  checkedOut: 'checkedOut',
  rejected: 'needsStaff',
  failed: 'needsStaff',
  attention: 'needsStaff',
  review: 'review',
  undone: 'undone',
};

/**
 * The customer-facing screen, for the native second display and the paired customer device. The
 * outcome reads from across a room by three things together: colour, icon and words.
 */
export function CustomerStage({
  tone,
  replay,
  brandName,
  logoUrl,
  title,
  amount,
  leaving,
  eyebrow,
  hint,
  notice,
  style,
}: {
  tone: StageTone;
  replay: number;
  brandName: string;
  logoUrl: string | null;
  title?: string;
  /** An amount under review: the words and the figure, which rolls when it changes. */
  amount?: { label: string; value: string };
  /** The amount is fading out: the draft was cancelled. */
  leaving?: boolean;
  eyebrow?: string;
  hint?: string;
  /** A short line for a connection problem, shown small at the bottom. */
  notice?: string | null;
  style?: React.CSSProperties;
}) {
  const look = STAGE[tone];
  const Icon = look.icon;
  return (
    <main
      className="cstage"
      data-testid="duo-customer-display"
      data-status={tone}
      data-signal={look.signal}
      style={style}
    >
      <header className="cstage-brand">
        <span className="cstage-brand-mark">
          <ScanOrgLogo
            className="cstage-brand-logo"
            src={logoUrl}
            name=""
            fallback={<span aria-hidden>{brandName.charAt(0) || 'P'}</span>}
          />
        </span>
        <p>{brandName}</p>
      </header>
      <section aria-live="polite" className="cstage-copy" key={`${tone}-${replay}`}>
        <span className="cstage-badge" aria-hidden>
          <Icon strokeWidth={2.5} />
        </span>
        <p className="cstage-eyebrow">{eyebrow || look.eyebrow}</p>
        {amount ? (
          <h1
            className="cstage-draft"
            data-testid="customer-draft"
            aria-atomic="true"
            {...(leaving ? { 'data-leaving': '' } : {})}
          >
            {amount.label ? (
              <span className="cstage-draft-label" aria-hidden="true">
                {amount.label}{' '}
              </span>
            ) : null}
            <span className="sr-only">{`${amount.label} ${amount.value}`.trim()}</span>
            <span className="cstage-draft-figure" aria-hidden="true">
              {figureSlots(amount.value).map(({ char, slot }) => (
                <span key={`${slot}-${char}`} className="cstage-digit">
                  {char}
                </span>
              ))}
            </span>
          </h1>
        ) : (
          <h1>{title || look.title}</h1>
        )}
        {hint || look.hint ? <p className="cstage-hint">{hint || look.hint}</p> : null}
      </section>
      <div aria-hidden="true" className="cstage-buddy">
        <CustomerBuddy className="cstage-buddy-art" status={BUDDY[tone]} replay={replay} />
      </div>
      {notice ? (
        <p role="status" className="cstage-notice">
          {notice}
        </p>
      ) : null}
    </main>
  );
}
