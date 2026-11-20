import { Ticket } from 'lucide-react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import type { ScanOutcome } from '../machine/types.ts';
import './identity.css';
import './pass-sheet.css';

/** Who the sheet is about: the photo or the pass tile, the name, the line under it. */
export function SheetHeader({
  outcome: o,
  card,
}: {
  outcome: ScanOutcome | null;
  card: ScanCard | null;
}) {
  const d = o?.display ?? card?.display ?? null;
  const name = d?.identity.holder || card?.title || o?.card?.title || o?.template?.name || 'Pass';
  const template = o?.template?.name ?? card?.template.name;
  const meta = [d?.header.meta ?? card?.subtitle, template]
    .filter((part, i, all) => part && all.indexOf(part) === i)
    .join(' · ');
  const photo = d?.identity.photo;
  return (
    <div className="scan-sheet-id">
      {photo?.url ? (
        <img className="scan-identity-photo" src={photo.url} alt={photo.alt} />
      ) : (
        <span className="scan-pass-tile" aria-hidden>
          <Ticket size={24} />
        </span>
      )}
      <div>
        <p className="scan-sheet-name" dir="auto">
          {name}
        </p>
        {meta ? <p className="scan-sheet-meta">{meta}</p> : null}
      </div>
    </div>
  );
}
