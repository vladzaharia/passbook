import { Check, CircleAlert, Info, Minus, TriangleAlert } from 'lucide-react';

export type StripKind = 'ok' | 'heads_up' | 'refused' | 'system';

export interface StripEntry {
  kind: StripKind;
  /** The holder or the system headline. */
  title: string;
  /** Time, place, staff: "6:42 PM". */
  meta: string;
  undoable?: boolean;
}

const GLYPH = { ok: Check, heads_up: TriangleAlert, refused: CircleAlert, system: Info } as const;

/** The dock's 40 px strip. It always holds its box: an empty strip shows a muted dash. */
export function LastScanStrip({
  entry,
  onOpen,
  onUndo,
}: {
  entry: StripEntry | null;
  onOpen?: () => void;
  onUndo?: () => void;
}) {
  const Glyph = entry ? GLYPH[entry.kind] : Minus;
  return (
    <div className="scan-dock-strip" data-testid="scan-last">
      <button
        type="button"
        className="scan-strip-main"
        onClick={onOpen}
        aria-label={
          entry
            ? `Last scan: ${entry.title} ${entry.meta}. Open Recent`
            : 'No scans yet. Open Recent'
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
          Undo
        </button>
      ) : null}
    </div>
  );
}
