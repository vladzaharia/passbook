import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  CircleX,
  TriangleAlert,
  Undo2,
  Users,
} from 'lucide-react';
import type { ScanPlaceRev } from '../../../shared/contracts/scan-occupancy.ts';
import type { ScanLiveRow } from '../../../shared/contracts/scan-setups.ts';
import { formatTime } from '../../lib/format.ts';
import { Buddy } from '../../ui/art/index.ts';
import { countsOf, type Fill, heroOf, type Trend, trendOf } from './monitor-model.ts';
import './monitor-board.css';

const ROW_ICON = {
  ok: Check,
  heads_up: TriangleAlert,
  refused: CircleX,
  ready: Users,
  undo: Undo2,
};
const FILL_WORD: Record<Fill, string | null> = { open: null, busy: 'Almost full', full: 'Full' };

/** A wall screen is public: direction and outcome only, never who. */
export function rowWord(row: ScanLiveRow): string {
  if (row.kind === 'ok') return row.direction === 'out' ? 'Out' : 'In';
  if (row.kind === 'refused') return 'Not accepted';
  if (row.kind === 'undo') return 'Undone';
  return 'Check needed';
}

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

/** The wall screen: how many are inside first, then the latest scans by first name. */
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
      <section aria-label="Inside now" className="mon-hero" data-fill={hero?.fill ?? 'open'}>
        <div className="mon-hero-main">
          <p className="mon-label">{hero?.name ? `Inside ${hero.name}` : 'Inside now'}</p>
          <p className="mon-count" data-testid="monitor-count">
            {hero ? hero.count : trend.entered}
            {hero?.capacity ? <span className="mon-cap"> / {hero.capacity}</span> : null}
          </p>
          {hero?.ratio !== null && hero ? (
            <div className="mon-meter" aria-hidden>
              <span style={{ width: `${Math.min(100, Math.round((hero.ratio ?? 0) * 100))}%` }} />
            </div>
          ) : null}
          {word ? (
            <p className="mon-fill-word">
              <TriangleAlert aria-hidden /> {word}
            </p>
          ) : null}
          {hero ? null : <p className="mon-label">checked in, last 15 min</p>}
          <Trendline trend={trend} />
        </div>
        <div className="mon-buddy" aria-hidden>
          <Buddy scene={hero?.fill === 'full' ? 'sorry' : 'peek'} size="lg" mood="happy" />
        </div>
        {others.length ? (
          <ul className="mon-places">
            {others.map((p) => (
              <li key={p.place}>
                <span>{p.name}</span>
                <b>
                  {p.inNow}
                  {p.capacity ? ` / ${p.capacity}` : ''}
                </b>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section aria-label="Recent scans" className="mon-recent">
        <h2>Recent scans</h2>
        {rows.length ? (
          <ol>
            {rows.slice(0, 8).map((row) => {
              const Icon = ROW_ICON[row.kind];
              return (
                <li key={row.id} data-kind={row.kind}>
                  <span className="mon-row-icon" aria-hidden>
                    <Icon />
                  </span>
                  <span className="mon-row-name">{rowWord(row)}</span>
                  <span className="mon-row-what">{row.scannerName}</span>
                  <time>{formatTime(row.at, timeZone)}</time>
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
