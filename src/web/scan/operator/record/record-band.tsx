import { CircleCheck, Eye, Info, OctagonX, TriangleAlert, Undo2 } from 'lucide-react';
import { SCAN_COPY } from '../../../../shared/copy/scan.ts';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { formatTime } from '../../../lib/format.ts';
import { Kbd } from '../workspace/command-field.tsx';
import type { Band } from './record-model.ts';

const GLYPH = {
  ok: CircleCheck,
  hu: TriangleAlert,
  no: OctagonX,
  sys: Info,
  preview: Eye,
} as const;

/** The verdict as colour, glyph and word; a preview or a choice is neutral. Undo stays while it can. */
export function RecordBand({
  band,
  where,
  timeZone,
  undo,
  kind,
  reason,
}: {
  band: Band;
  where: string | null;
  timeZone: string | undefined;
  undo: (() => void) | null;
  kind: string;
  reason: string | null;
}) {
  const Glyph = GLYPH[band.tone];
  return (
    <div
      className="op-band"
      data-tone={band.tone}
      data-testid="scan-verdict"
      data-kind={kind}
      data-reason={reason ?? undefined}
    >
      <span className="op-band-glyph">
        <Glyph aria-hidden />
      </span>
      <p className="op-band-text">
        <b>{band.title}</b>
        {band.pill ? (
          <span className="op-band-pill" data-testid="scan-dir-pill">
            {SCAN_COPY.direction[band.pill]}
          </span>
        ) : null}
        {band.sub ? <span className="op-band-sub">{band.sub}</span> : null}
      </p>
      {band.at || where ? (
        <span className="op-band-when">
          {[where, band.at ? formatTime(band.at, timeZone) : null].filter(Boolean).join(' · ')}
        </span>
      ) : null}
      {undo ? (
        <button
          type="button"
          className="op-band-undo"
          onClick={undo}
          aria-keyshortcuts="Control+Z Meta+Z"
        >
          <Undo2 aria-hidden /> {OPERATOR_COPY.record.undo}{' '}
          <span className="op-keycap" aria-hidden>
            <Kbd>⌘Z</Kbd>
          </span>
        </button>
      ) : null}
    </div>
  );
}
