import { Nfc, ShieldCheck } from 'lucide-react';
import type { ScanTag } from '../../../shared/contracts/nfc-tags.ts';

/** `⌁ •• 7F3A · Basic`: the tag's last two bytes, read digit by digit. */
export function TagChip({
  hint,
  assurance,
  name,
}: {
  hint: string;
  assurance: ScanTag['assurance'];
  /** The name staff typed, shown before the code. */
  name?: string;
}) {
  const spoken = hint.split('').join(' ');
  return (
    <span className="scan-tag-chip" data-testid="scan-tag-chip">
      <Nfc aria-hidden size={15} />
      {name ? <span className="scan-tag-chip-name">{name}</span> : null}
      <span className="scan-tag-chip-code" aria-hidden>
        •• {hint}
      </span>
      <span className="sr-only">{`Tag ends ${spoken}`}</span>
      <span className="scan-tag-pill" data-assurance={assurance}>
        {assurance === 'secure' ? <ShieldCheck aria-hidden size={12} /> : null}
        {assurance === 'secure' ? 'Secure' : 'Basic'}
      </span>
    </span>
  );
}
