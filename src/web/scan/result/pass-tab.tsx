import { Info } from 'lucide-react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { DisplayPanels } from '../display/display-panels.tsx';
import type { ScanOutcome } from '../machine/types.ts';
import { verdictLine } from '../machine/verdict-lines.ts';
import { DISC_GLYPH } from '../ui/disc-glyph.ts';
import { rowLabel } from '../ui/recent-scans.tsx';
import { sessionTime } from '../ui/session-time.ts';
import { toneOf } from './tone.ts';
import './pass-sheet.css';

const COPY = SCAN_HANDHELD_COPY.sheet;

/** What happened to this pass on the scan that opened the sheet: when, where, and what to do. */
function VerdictLine({
  outcome: o,
  now,
  where,
}: {
  outcome: ScanOutcome;
  now: number;
  where: string;
}) {
  const tone = toneOf(o.kind);
  const Glyph = DISC_GLYPH[tone];
  const time = o.at ? sessionTime(o.at) : '';
  const said = tone === 'ok' ? null : verdictLine(o, now);
  const first = tone === 'ok' ? rowLabel(o, now) : (said?.headline ?? rowLabel(o, now));
  return (
    <div className="scan-verdict-line" data-kind={tone} data-testid="scan-pass-verdict">
      <span aria-hidden className="scan-strip-disc" data-kind={tone}>
        <Glyph size={15} strokeWidth={2.5} />
      </span>
      <div>
        <p>{[first, time, tone === 'ok' ? where : ''].filter(Boolean).join(' · ')}</p>
        {said?.sub ? <p className="scan-verdict-line-sub">{said.sub}</p> : null}
      </div>
    </div>
  );
}

/** This pass: the verdict, the template's display, the notes, and what the pass did today. */
export function PassTab({
  outcome: o,
  card,
  notes,
  now,
  where,
}: {
  outcome: ScanOutcome | null;
  card: ScanCard | null | undefined;
  notes: string[];
  now: number;
  where: string;
}) {
  const own = o?.display && o.display.screen !== 'refused' ? o.display : null;
  const display = own ?? card?.display ?? null;
  return (
    <>
      {o ? <VerdictLine outcome={o} now={now} where={where} /> : null}
      {display?.panels.length ? <DisplayPanels display={display} /> : null}
      {notes.length ? (
        <div className="scan-result-notes">
          <Info size={20} aria-hidden />
          <div>
            {notes.map((note) => (
              <p key={note}>{note}</p>
            ))}
          </div>
        </div>
      ) : null}
      {card?.lastScans.length ? (
        <section aria-labelledby="scan-today" className="scan-today">
          <h2 id="scan-today">{COPY.today}</h2>
          <ul>
            {card.lastScans.map((scan) => {
              const kind = toneOf(scan.outcome);
              const Glyph = DISC_GLYPH[kind];
              return (
                <li key={scan.scanId}>
                  <span aria-hidden className="scan-strip-disc" data-kind={kind}>
                    <Glyph size={15} strokeWidth={2.5} />
                  </span>
                  <div>
                    <p>{scan.actionLabel}</p>
                    <p>
                      {sessionTime(scan.at)} · {scan.scannerName}
                    </p>
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </>
  );
}
