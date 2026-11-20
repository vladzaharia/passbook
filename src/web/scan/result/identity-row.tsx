import { ChevronRight, Ticket } from 'lucide-react';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { scanIcon } from '../display/icons.ts';
import type { ScanOutcome } from '../machine/types.ts';

function identityChips(o: ScanOutcome, d: ScanDisplay | null, compact: boolean) {
  if (compact)
    return o.reason === 'voided'
      ? [
          <span key="voided" className="scan-identity-chip" data-tone="neutral">
            Voided
          </span>,
        ]
      : [];
  return [
    ...o.flags.map((flag) => (
      <span key={flag} className="scan-identity-chip" data-tone="gold">
        {flag}
      </span>
    )),
    ...(d?.header.chips ?? []).map((chip) => {
      const Icon = chip.icon ? scanIcon(chip.icon) : null;
      return (
        <span key={chip.id} className="scan-identity-chip" data-tone={chip.tone}>
          {Icon ? <Icon size={14} aria-hidden /> : null}
          {chip.text}
        </span>
      );
    }),
  ];
}

export function IdentityRow({
  outcome: o,
  display: d,
  onPass,
  hideName = false,
  compact: forceCompact = false,
  glance = false,
}: {
  outcome: ScanOutcome;
  display: ScanDisplay | null;
  onPass: () => void;
  /** The band already says the holder's name: the row keeps the rest. */
  hideName?: boolean;
  /** A verdict that did not apply: no photo or chips. */
  compact?: boolean;
  /** A handheld's glance card: one chip, meta beside it, a chevron for show (the card itself opens the pass). */
  glance?: boolean;
}) {
  const compact = o.kind === 'refused' || forceCompact;
  const title = compact
    ? (d?.identity.holder ?? o.card?.title ?? o.template?.name)
    : d?.identity.holder;
  if (!title) return null;
  const photo = !compact ? d?.identity.photo : null;
  const meta = compact
    ? o.template?.name && title !== o.template.name
      ? o.template.name
      : null
    : d?.header.meta;
  const chips = identityChips(o, d, compact);
  return (
    <div className="scan-identity" data-compact={compact || undefined}>
      {photo?.url ? (
        <img className="scan-identity-photo" src={photo.url} alt={photo.alt} />
      ) : (
        <span className="scan-pass-tile" aria-hidden>
          <Ticket size={22} />
        </span>
      )}
      <div className="scan-identity-text">
        {hideName ? null : (
          <p className="scan-result-holder" dir="auto">
            {title}
          </p>
        )}
        {glance ? (
          <div className="scan-identity-metaline">
            {meta ? <p className="scan-identity-meta">{meta}</p> : null}
            {chips[0]}
          </div>
        ) : (
          <>
            {meta ? <p className="scan-identity-meta">{meta}</p> : null}
            {chips.length ? <div className="scan-identity-chips">{chips}</div> : null}
          </>
        )}
      </div>
      {!compact && (o.card || o.scanId) ? (
        glance ? (
          <span aria-hidden className="scan-pass-open">
            <ChevronRight size={18} />
          </span>
        ) : (
          <button type="button" className="scan-pass-open" aria-label="View pass" onClick={onPass}>
            <ChevronRight size={18} aria-hidden />
          </button>
        )
      ) : null}
    </div>
  );
}
