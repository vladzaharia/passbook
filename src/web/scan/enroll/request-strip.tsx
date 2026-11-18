import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { fill } from '../ui/copy.ts';
import '../assign/assign.css';

/** A request waits while a desk panel has a draft: Open takes over, Later keeps the chip. */
export function RequestStrip({
  name,
  onOpen,
  onLater,
}: {
  name: string;
  onOpen: () => void;
  onLater: () => void;
}) {
  return (
    <div className="scan-request-strip" role="status" data-testid="scan-request-strip">
      <span>{fill(SCAN_TAG_COPY.request.strip, { name })}</span>
      <button type="button" data-primary onClick={onOpen}>
        {SCAN_TAG_COPY.request.open}
      </button>
      <button type="button" onClick={onLater}>
        {SCAN_TAG_COPY.request.later}
      </button>
    </div>
  );
}
