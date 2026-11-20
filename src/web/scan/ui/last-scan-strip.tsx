import { Minus, Undo2 } from 'lucide-react';
import { DISC_GLYPH } from './disc-glyph.ts';

export type StripKind = 'ok' | 'heads_up' | 'refused' | 'system';

export interface StripEntry {
  kind: StripKind;
  /** The holder or the system headline. */
  title: string;
  /** Time, place, staff: "6:42 PM". */
  meta: string;
  undoable?: boolean;
}

/** The dock's strip: 44 px on a handheld (the name over its meta), 48 on a tablet. It always holds its box: an empty strip shows a muted dash. */
export function LastScanStrip({
  entry,
  onOpen,
  onUndo,
}: {
  entry: StripEntry | null;
  onOpen?: () => void;
  onUndo?: () => void;
}) {
  const Glyph = entry ? DISC_GLYPH[entry.kind] : Minus;
  return (
    <div className="scan-dock-strip" data-testid="scan-last">
      <button
        type="button"
        className="scan-strip-main"
        onClick={onOpen}
        aria-label={
          entry
            ? `Last scan: ${entry.title} ${entry.meta}. Open details`
            : 'No scans yet. Open recent scans'
        }
      >
        <span aria-hidden className="scan-strip-disc" data-kind={entry?.kind}>
          <Glyph size={15} strokeWidth={2.5} />
        </span>
        <span aria-hidden className="scan-strip-text">
          <span className="scan-strip-title" dir="auto">
            {entry ? entry.title : 'No scans yet'}
          </span>
          {entry ? (
            <>
              {' '}
              <span className="scan-strip-meta">{entry.meta}</span>
            </>
          ) : null}
        </span>
      </button>
      {entry?.undoable ? (
        <button type="button" className="scan-strip-undo" onClick={onUndo}>
          <Undo2 aria-hidden size={18} className="scan-strip-undo-icon" />
          Undo
        </button>
      ) : null}
    </div>
  );
}
