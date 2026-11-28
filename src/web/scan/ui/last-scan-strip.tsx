import { CloudOff, Minus, Undo2 } from 'lucide-react';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { DISC_GLYPH } from './disc-glyph.ts';

export type StripKind = 'ok' | 'heads_up' | 'refused' | 'system';

export interface StripEntry {
  kind: StripKind;
  /** The holder or the system headline. */
  title: string;
  /** Time, place, staff: "6:42 PM". */
  meta: string;
  undoable?: boolean;
  /** Offline with scans saved: the strip is the queue line and View opens the queue. */
  view?: boolean;
  icon?: 'offline';
}

/** The dock's strip: 44 px on a handheld (the name over its meta), 48 on a tablet. It always holds its box: an empty strip shows a muted dash. */
export function LastScanStrip({
  entry,
  onOpen,
  onUndo,
  onView,
}: {
  entry: StripEntry | null;
  onOpen?: () => void;
  onUndo?: () => void;
  onView?: () => void;
}) {
  const Glyph = entry?.icon === 'offline' ? CloudOff : entry ? DISC_GLYPH[entry.kind] : Minus;
  return (
    <div className="scan-dock-strip" data-testid="scan-last">
      <button
        type="button"
        className="scan-strip-main"
        onClick={entry?.view ? onView : onOpen}
        aria-label={
          entry?.view
            ? `${entry.title}. ${entry.meta}`
            : entry
              ? `Last scan: ${entry.title} ${entry.meta}. Open details`
              : 'No scans on this device. Open recent scans'
        }
      >
        <span aria-hidden className="scan-strip-disc" data-kind={entry?.kind}>
          <Glyph size={15} strokeWidth={2.5} />
        </span>
        <span aria-hidden className="scan-strip-text">
          <span className="scan-strip-title" dir="auto">
            {entry ? entry.title : 'None on this device'}
          </span>
          {entry ? (
            <>
              {' '}
              <span className="scan-strip-meta">{entry.meta}</span>
            </>
          ) : null}
        </span>
      </button>
      {entry?.view ? (
        <button
          type="button"
          className="scan-strip-view"
          data-testid="scan-queue-view"
          onClick={onView}
        >
          {SCAN_HANDHELD_COPY.queue.view}
        </button>
      ) : null}
      {entry?.undoable ? (
        <button type="button" className="scan-strip-undo" onClick={onUndo}>
          <Undo2 aria-hidden size={18} className="scan-strip-undo-icon" />
          Undo
        </button>
      ) : null}
    </div>
  );
}
