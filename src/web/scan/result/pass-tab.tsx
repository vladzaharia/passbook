import { Info, Nfc } from 'lucide-react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';
import { DisplayPanels } from '../display/display-panels.tsx';
import type { ScanOutcome } from '../machine/types.ts';
import { verdictLine } from '../machine/verdict-lines.ts';
import { DISC_GLYPH } from '../ui/disc-glyph.ts';
import { rowLabel } from '../ui/recent-scans.tsx';
import { sessionTime } from '../ui/session-time.ts';
import { type Tone, toneOf } from './tone.ts';
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

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

interface TodayRow {
  id: string;
  kind: Tone;
  label: string;
  meta: string;
}

/**
 * This pass's scans today: the scan on screen, then what the card reports. The card names the door
 * and the action but not the staff member; a scan this device made says "you".
 */
function todayRows(
  o: ScanOutcome | null,
  card: ScanCard | null | undefined,
  now: number,
  where: string,
  mine: ReadonlySet<string>,
): TodayRow[] {
  const line = (time: number, door: string, id: string) =>
    [sessionTime(time), door, mine.has(id) ? COPY.by : ''].filter(Boolean).join(' · ');
  const rows: TodayRow[] = [];
  if (o?.scanId && o.at && sameDay(o.at, now))
    rows.push({
      id: o.scanId,
      kind: toneOf(o.kind),
      label: rowLabel(o, now),
      meta: line(o.at, where, o.scanId),
    });
  for (const scan of card?.lastScans ?? [])
    if (!rows.some((r) => r.id === scan.scanId) && sameDay(scan.at, now))
      rows.push({
        id: scan.scanId,
        kind: toneOf(scan.outcome),
        label: scan.actionLabel,
        meta: line(scan.at, scan.scannerName, scan.scanId),
      });
  return rows;
}

/** This pass: the verdict, the template's display, the notes, and what the pass did today. */
export function PassTab({
  outcome: o,
  card,
  notes,
  now,
  where,
  mine,
}: {
  outcome: ScanOutcome | null;
  card: ScanCard | null | undefined;
  notes: string[];
  now: number;
  where: string;
  /** Scan ids this device made: the API names the door, not the staff member, so these say "you". */
  mine: ReadonlySet<string>;
}) {
  const today = todayRows(o, card, now, where, mine);
  const tag = card?.tag ?? o?.tag ?? null;
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
      {today.length || tag ? (
        <section aria-labelledby="scan-today" className="scan-today">
          <h2 id="scan-today">{COPY.today}</h2>
          <ul>
            {today.map((row) => {
              const Glyph = DISC_GLYPH[row.kind];
              return (
                <li key={row.id}>
                  <span aria-hidden className="scan-strip-disc" data-kind={row.kind}>
                    <Glyph size={15} strokeWidth={2.5} />
                  </span>
                  <div>
                    <p>{row.label}</p>
                    <p>{row.meta}</p>
                  </div>
                </li>
              );
            })}
            {tag ? (
              <li>
                <span aria-hidden className="scan-strip-disc" data-kind="none">
                  <Nfc size={15} strokeWidth={2.5} />
                </span>
                <div>
                  <p>{COPY.tagLinked}</p>
                  <p>
                    {[tag.typeName, COPY.tagEnds.replace('{hint}', tag.hint)]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </li>
            ) : null}
          </ul>
        </section>
      ) : null}
    </>
  );
}
