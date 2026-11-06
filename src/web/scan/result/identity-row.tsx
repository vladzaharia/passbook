import { ChevronRight, Ticket } from 'lucide-react';
import type { ScanDisplay } from '../../../shared/contracts/scan-display.ts';
import { scanIcon } from '../display/icons.ts';
import type { ScanOutcome } from '../machine/types.ts';

export function IdentityRow({
  outcome: o,
  display: d,
  onPass,
}: {
  outcome: ScanOutcome;
  display: ScanDisplay | null;
  onPass: () => void;
}) {
  const compact = o.kind === 'refused';
  const title = compact
    ? (d?.identity.holder ?? o.card?.title ?? o.template?.name)
    : d?.identity.holder;
  if (!title) return null;
  const photo = !compact ? d?.identity.photo : null;
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
        <p className="scan-result-holder" dir="auto">
          {title}
        </p>
        {compact ? (
          o.template?.name && title !== o.template.name ? (
            <p className="scan-identity-meta">{o.template.name}</p>
          ) : null
        ) : d?.header.meta ? (
          <p className="scan-identity-meta">{d.header.meta}</p>
        ) : null}
        {!compact && (o.flags.length || d?.header.chips.length) ? (
          <div className="scan-identity-chips">
            {o.flags.map((flag) => (
              <span key={flag} className="scan-identity-chip" data-tone="gold">
                {flag}
              </span>
            ))}
            {d?.header.chips.map((chip) => {
              const Icon = chip.icon ? scanIcon(chip.icon) : null;
              return (
                <span key={chip.id} className="scan-identity-chip" data-tone={chip.tone}>
                  {Icon ? <Icon size={14} aria-hidden /> : null}
                  {chip.text}
                </span>
              );
            })}
          </div>
        ) : null}
        {compact && o.reason === 'voided' ? (
          <span className="scan-identity-chip" data-tone="neutral">
            Voided
          </span>
        ) : null}
      </div>
      {!compact && (o.card || o.scanId) ? (
        <button type="button" className="scan-pass-open" aria-label="View pass" onClick={onPass}>
          <ChevronRight size={18} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
