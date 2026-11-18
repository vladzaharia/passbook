import { ChevronRight, Nfc } from 'lucide-react';
import { useState } from 'react';
import { SCAN_TAG_COPY } from '../../../shared/copy/scan-tags.ts';
import { flagText, noneLine } from './tag-lines.ts';
import { TagPassesSheet } from './tag-passes-sheet.tsx';
import type { TagView } from './types.ts';

/**
 * The system flag on a result read from a tag: `Tag`, or `Tag · 1 of Maya's 3 passes` with a
 * chevron that opens Why this pass (Desk and up). After a refusal the same sheet is Why not?.
 */
export function TagFlag({
  tag,
  holder,
  refused,
}: {
  tag: TagView;
  holder: string | null | undefined;
  refused: boolean;
}) {
  const [open, setOpen] = useState(false);
  const passes = tag.passes ?? [];
  const label = flagText(tag, holder);
  const none = refused ? noneLine(tag, holder) : null;
  const why = refused ? SCAN_TAG_COPY.door.whyNot : SCAN_TAG_COPY.door.why;
  return (
    <>
      {passes.length > 0 ? (
        <button
          type="button"
          className="scan-tag-flag"
          data-testid="scan-tag-flag"
          aria-haspopup="dialog"
          aria-label={`${label}. ${why}`}
          onClick={() => setOpen(true)}
        >
          <Nfc aria-hidden size={14} />
          {label}
          <ChevronRight aria-hidden size={14} />
        </button>
      ) : (
        <span className="scan-tag-flag" data-testid="scan-tag-flag">
          <Nfc aria-hidden size={14} />
          {label}
        </span>
      )}
      {none ? (
        <p className="scan-tag-none" data-testid="scan-tag-none">
          {none}{' '}
          {passes.length > 0 ? (
            <button type="button" className="scan-tag-flag" onClick={() => setOpen(true)}>
              {SCAN_TAG_COPY.door.whyNot}
            </button>
          ) : null}
        </p>
      ) : null}
      {passes.length > 0 ? (
        <TagPassesSheet
          open={open}
          onClose={() => setOpen(false)}
          holder={holder}
          passes={passes}
        />
      ) : null}
    </>
  );
}
