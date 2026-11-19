import {
  ArrowDownRight,
  ArrowUpRight,
  CircleX,
  LogIn,
  LogOut,
  ScanLine,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';
import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/index.ts';
import '../buddy/beats.css';
import { fill } from '../ui/copy.ts';
import './monitor-board.css';
import type { MonitorBeat } from './monitor-beat.ts';
import { LetInButton } from './monitor-desk.tsx';
import { countsOf, type Fill, heroOf, resolvedOf, type Trend, trendOf } from './monitor-model.ts';

const ROW_ICON = {
  ok: LogIn,
  heads_up: TriangleAlert,
  refused: CircleX,
  ready: ScanLine,
  undo: Undo2,
};
const FILL_WORD: Record<Fill, string | null> = { open: null, busy: 'Almost full', full: 'Full' };

function Trendline({ trend }: { trend: Trend }) {
  return (
    <ul className="mon-trend" aria-label="Last 15 minutes">
      <li>
        <ArrowUpRight aria-hidden /> {trend.entered} in
      </li>
      <li>
        <ArrowDownRight aria-hidden /> {trend.left} out
      </li>
      <li className="mon-trend-note">last 15 min</li>
    </ul>
  );
}

/** The staff monitor: a compact occupancy header, then who just scanned, as the server allows. */
export function MonitorBoard({
  rows,
  places,
  now,
  timeZone,
  beat,
  inside,
  onLetIn,
  letInDone,
}: {
  rows: ScanLiveRow[];
  places: ScanPlaceRev[];
  now: number;
  timeZone?: string;
  beat?: MonitorBeat;
  /** The staff inside list; with it the recent scans become the side column. */
  inside?: ReactNode;
  onLetIn?: (row: ScanLiveRow) => void;
  /** Scans this monitor let in itself, before the feed says so. */
  letInDone?: ReadonlyMap<string, string>;
}) {
  const resolved = resolvedOf(rows, letInDone);
  const counts = countsOf(places, rows);
  const hero = heroOf(counts);
  const trend = trendOf(rows, now);
  const others = counts.slice(1, 5);
  const word = hero ? FILL_WORD[hero.fill] : null;
  return (
    <div className="mon-board">
      <section aria-label="Inside now" className="mon-head" data-fill={hero?.fill ?? 'open'}>
        <div className="mon-head-count">
          <p className="mon-label">
            {hero ? (hero.name ? `Inside ${hero.name}` : 'Inside now') : 'Checked in, last 15 min'}
          </p>
          <p className="mon-count" data-testid="monitor-count">
            {hero ? hero.count : trend.entered}
            {hero?.capacity ? <span className="mon-cap"> / {hero.capacity}</span> : null}
          </p>
        </div>
        <div className="mon-head-side">
          {hero && hero.ratio !== null ? (
            <div className="mon-meter" aria-hidden>
              <span style={{ width: `${Math.min(100, Math.round(hero.ratio * 100))}%` }} />
            </div>
          ) : null}
          <div className="mon-head-facts">
            {word ? (
              <p className="mon-fill-word">
                <TriangleAlert aria-hidden /> {word}
              </p>
            ) : null}
            <Trendline trend={trend} />
            {others.map((p) => (
              <p key={p.place} className="mon-place">
                {p.name}{' '}
                <b>
                  {p.inNow}
                  {p.capacity ? ` / ${p.capacity}` : ''}
                </b>
              </p>
            ))}
          </div>
        </div>
        <div className="mon-buddy" aria-hidden>
          {beat?.beat ? (
            <Buddy
              key={beat.key}
              scene="scan"
              size="lg"
              mood={beat.beat === 'shake' ? 'sad' : 'happy'}
              beat={beat.beat}
              immediate
            />
          ) : (
            <Buddy scene={hero?.fill === 'full' ? 'sorry' : 'peek'} size="lg" mood="happy" />
          )}
        </div>
      </section>
      <div className="mon-main" data-inside={inside ? '' : undefined}>
        {inside}
        <section aria-label="Recent scans" className="mon-recent">
          <h2>Recent scans</h2>
          {rows.length ? (
            <ol className="mon-grid">
              {rows.map((row) => {
                const Icon =
                  row.kind === 'ok' && row.direction === 'out' ? LogOut : ROW_ICON[row.kind];
                return (
                  <li key={row.id} data-kind={row.kind}>
                    <span className="mon-avatar">
                      {row.photoUrl ? (
                        <img src={row.photoUrl} alt={row.holder ?? 'Member'} />
                      ) : (
                        <ScanLine aria-hidden />
                      )}
                    </span>
                    <span className="mon-row-body">
                      <span className="mon-row-name">{row.holder ?? row.label}</span>
                      {row.holder ? <span className="mon-row-what">{row.label}</span> : null}
                      <span className="mon-row-meta">
                        {row.scannerName} · {formatTime(row.at, timeZone)}
                      </span>
                      {row.scanId && resolved.has(row.scanId) ? (
                        <span className="mon-row-resolved">
                          {resolved.get(row.scanId)
                            ? fill(SCAN_COPY.verdict.resolvedBy, {
                                staff: resolved.get(row.scanId) ?? '',
                              })
                            : 'Resolved'}
                        </span>
                      ) : null}
                    </span>
                    {row.scanId && onLetIn && !resolved.has(row.scanId) ? (
                      <LetInButton row={row} onLetIn={() => onLetIn(row)} />
                    ) : null}
                    <span className="mon-row-icon" aria-hidden>
                      <Icon />
                    </span>
                  </li>
                );
              })}
            </ol>
          ) : (
            <p className="mon-empty">Ready for the first scan</p>
          )}
        </section>
      </div>
    </div>
  );
}
