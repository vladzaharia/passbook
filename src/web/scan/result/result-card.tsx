import { Info } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import type { ScanCard } from '../../../shared/contracts/scan.ts';
import { SCAN_COPY, SCAN_REASON_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { formatDateTime, formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { DisplayPanels } from '../display/display-panels.tsx';
import { scanIcon } from '../display/icons.ts';
import type { ScanOutcome } from '../machine/types.ts';
import { IdentityRow } from './identity-row.tsx';
import { VerdictGlyph } from './verdict-glyph.tsx';
import './result.css';
import './identity.css';
import './motion.css';

export function ResultCard({
  outcome: o,
  phase,
  onAction,
  eventNote,
  holdMs,
  onPass,
}: {
  outcome: ScanOutcome;
  phase?: string;
  onAction?: (actionId: string) => void;
  eventNote?: string | null;
  holdMs?: number | null;
  onPass?: (card: ScanCard | null) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const d = o.display;
  const ok = o.kind === 'ok';
  const ready = o.kind === 'ready';
  const noExit =
    o.reason === 'not_accepted' && o.checkIn?.direction === 'out' && o.checkIn.mode !== 'in_out';
  const noReentry =
    o.reason === 'already_done' && o.checkIn?.mode === 'in_out' && !o.checkIn.inside;
  const line = o.reason ? SCAN_REASON_COPY[o.reason] : null;
  const values = {
    template: o.template?.name ?? 'This pass',
    event: 'this event',
    date: formatDateTime(o.at),
    time: o.at ? formatTime(o.at) : '',
    ago: o.previous ? formatTime(o.previous.at) : o.at ? formatTime(o.at) : '',
    scanner:
      o.previous?.scannerName ??
      (o.reason === 'still_inside'
        ? 'Entry recorded'
        : o.reason === 'already_done'
          ? 'Earlier scan'
          : ''),
    flag: o.flags[0] ?? 'Check required',
    action: o.action?.label ?? 'This action',
    in: o.counts.event?.arrived ?? 0,
    capacity: o.counts.event?.capacity ?? 0,
    seconds: Math.ceil((o.retryAfterMs ?? 1000) / 1000),
    verb: 'Checked in',
    noun: 'check-in',
    wait: `${Math.ceil((o.cooldownRemainingMs ?? 0) / 60000)} min`,
  };
  const systemTitle =
    o.action?.id === 'undo'
      ? 'Undone'
      : ok
        ? o.action?.kind === 'check_in'
          ? o.checkIn?.direction === 'out'
            ? 'Checked out'
            : SCAN_COPY.verdict.checkedIn
          : (o.action?.label ?? 'Done')
        : line
          ? scanLine(line.headline, values)
          : 'Choose an action';
  const custom =
    ok && Boolean(d?.header.title) && o.action?.id !== 'undo' && o.checkIn?.direction !== 'out';
  const title = noExit
    ? 'Check-out not allowed'
    : noReentry
      ? 'No re-entry'
      : custom
        ? d?.header.title
        : systemTitle;
  const CustomGlyph = ok && d?.header.icon ? scanIcon(d.header.icon) : null;
  const layout = custom ? 'custom' : o.kind === 'ok' || o.kind === 'heads_up' ? 'row' : 'stack';
  const notes = [
    o.kind === 'refused' ? d?.notes.refused : d?.notes.staff,
    o.kind === 'refused' || o.kind === 'heads_up' ? eventNote : null,
  ].filter(Boolean);
  useLayoutEffect(() => {
    const el = root.current;
    if (!el || phase !== 'rising' || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const pass = document.querySelector('.scan-buddy-seat');
    if (!pass) return;
    const from = pass.getBoundingClientRect();
    el.style.animation = 'none';
    const to = el.getBoundingClientRect();
    el.style.setProperty('--fx', `${from.left + from.width / 2 - to.left - to.width / 2}px`);
    el.style.setProperty('--fy', `${from.top + from.height / 2 - to.top - to.height / 2}px`);
    el.style.setProperty('--sx', String(48 / to.width));
    el.style.setProperty('--sy', String(64 / to.height));
    el.style.animation = '';
  }, [phase]);
  return (
    <section
      ref={root}
      className="scan-result"
      data-kind={o.kind}
      data-phase={phase}
      data-screen={d?.screen ?? o.kind}
      data-reason={o.reason}
      data-milestone={o.milestone || undefined}
      data-testid="scan-result"
      aria-labelledby="scan-result-heading"
    >
      {!ready ? (
        <div
          className="scan-result-band"
          data-layout={layout}
          data-testid="scan-verdict"
          data-kind={o.kind}
          data-reason={o.reason}
          data-phase={phase}
          data-screen={d?.screen ?? o.kind}
        >
          <div className="scan-glyph-row">
            {CustomGlyph ? (
              <span className="scan-custom-glyph">
                <CustomGlyph aria-hidden />
                <span className="scan-custom-badge">
                  <VerdictGlyph kind="ok" />
                </span>
              </span>
            ) : (
              <VerdictGlyph kind={o.kind} />
            )}
            {custom ? <p className="scan-verdict-eyebrow">{systemTitle}</p> : null}
          </div>
          <div className="scan-verdict-text">
            <h1 id="scan-result-heading" tabIndex={-1}>
              {title}
            </h1>
            {noExit ? (
              <p>This pass only allows check-ins.</p>
            ) : noReentry ? (
              <p>This event allows one entry.</p>
            ) : line?.sub ? (
              <p>{scanLine(line.sub, values)}</p>
            ) : null}
          </div>
          {holdMs ? (
            <span
              key={o.scanId}
              aria-hidden
              className="scan-hold-rail"
              style={{ animationDuration: `${holdMs}ms` }}
            />
          ) : null}
        </div>
      ) : (
        <h1 className="scan-ready-heading" id="scan-result-heading" tabIndex={-1}>
          Choose an action
        </h1>
      )}
      {d || o.card || notes.length ? (
        <div className="scan-result-body">
          <IdentityRow
            outcome={o}
            display={d}
            onPass={() => {
              onPass?.(o.card);
            }}
          />
          {d && o.kind !== 'refused' ? <DisplayPanels display={d} /> : null}
          {notes.length ? (
            <div className="scan-result-notes">
              <Info size={18} aria-hidden />
              <div>
                {notes.map((note) => (
                  <p key={note}>{note}</p>
                ))}
              </div>
            </div>
          ) : null}
          {ready &&
            o.card?.actions
              .filter((a) => a.kind === 'check_in')
              .map((action) => (
                <Button
                  key={action.id}
                  disabled={!action.available}
                  onClick={() => onAction?.(action.id)}
                >
                  {action.label}
                </Button>
              ))}
        </div>
      ) : null}
    </section>
  );
}
