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
import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/index.ts';
import './monitor-board.css';
import { countsOf, type Fill, heroOf, type Trend, trendOf } from './monitor-model.ts';

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
}: {
  rows: ScanLiveRow[];
  places: ScanPlaceRev[];
  now: number;
  timeZone?: string;
}) {
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
          <Buddy scene={hero?.fill === 'full' ? 'sorry' : 'peek'} size="lg" mood="happy" />
        </div>
      </section>
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
                  </span>
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
  );
}
