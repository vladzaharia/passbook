import { SCAN_REASON_COPY } from '../../../shared/copy/scan.ts';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { Button } from '../../ui/button.tsx';
import { Sheet, SheetContent } from '../../ui/sheet.tsx';
import { fill } from '../ui/copy.ts';
import { firstName } from './tag-lines.ts';
import type { TagPass } from './types.ts';

const reasonText = (reason: string | null): string => {
  const line = reason ? (SCAN_REASON_COPY as Record<string, { headline: string }>)[reason] : null;
  return line ? line.headline.replace(/\{\w+\}/g, '').trim() : 'Refused';
};

const stateText = (p: TagPass): string => {
  const c = SCAN_TAG_COPY.door;
  switch (p.state) {
    case 'used':
    case 'lets_in':
      return p.state === 'used' ? c.letsIn : c.alsoLetsIn;
    case 'not_here':
      return c.notHere;
    case 'unchecked':
      return c.alsoLetsIn;
    default:
      return reasonText(p.reason);
  }
};

/** Why this pass / Why not?: each of the person's passes the tag tried, with its state. No action per row. */
export function TagPassesSheet({
  open,
  onClose,
  holder,
  passes,
}: {
  open: boolean;
  onClose: () => void;
  holder: string | null | undefined;
  passes: readonly TagPass[];
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        title={fill(SCAN_TAG_COPY.door.whyTitle, { name: firstName(holder), n: passes.length })}
        className="scan-detail-sheet"
      >
        <ul className="scan-tag-passes" data-testid="scan-tag-passes">
          {passes.map((p, i) => (
            <li key={p.passId ?? i} className="scan-tag-pass">
              <span className="scan-tag-pass-name">{p.templateName ?? 'Pass'}</span>
              {p.state === 'used' ? (
                <span className="scan-tag-pass-used">{SCAN_TAG_COPY.door.used}</span>
              ) : null}
              <span className="scan-tag-pass-state" data-state={p.state}>
                {stateText(p)}
              </span>
            </li>
          ))}
        </ul>
        <Button onClick={onClose}>Done</Button>
      </SheetContent>
    </Sheet>
  );
}
