import { Check, CircleAlert, Info, TriangleAlert } from 'lucide-react';
import { SCAN_COPY, SCAN_REASON_COPY, scanLine } from '../../../shared/copy/scan.ts';
import { formatDateTime, formatTime } from '../../lib/format.ts';
import { Button } from '../../ui/button.tsx';
import { DisplayPanels } from '../display/display-panels.tsx';
import { scanIcon } from '../display/icons.ts';
import type { ScanOutcome } from '../machine/types.ts';
import './result.css';

export function ResultCard({
  outcome: o,
  phase,
  onAction,
}: {
  outcome: ScanOutcome;
  phase?: string;
  onAction?: (actionId: string) => void;
}) {
  const d = o.display ?? o.card?.display;
  const ok = o.kind === 'ok';
  const Glyph = ok
    ? Check
    : o.kind === 'heads_up'
      ? TriangleAlert
      : o.kind === 'refused'
        ? CircleAlert
        : Info;
  const line = o.reason ? SCAN_REASON_COPY[o.reason] : null;
  const values = {
    template: o.template?.name ?? 'This pass',
    event: 'this event',
    date: formatDateTime(o.at),
    time: o.at ? formatTime(o.at) : '',
    ago: o.previous ? formatTime(o.previous.at) : '',
    scanner: o.previous?.scannerName ?? '',
    flag: o.flags[0] ?? 'Check required',
    action: o.action?.label ?? 'This action',
    in: o.counts.event?.arrived ?? 0,
    capacity: o.counts.event?.capacity ?? 0,
    seconds: Math.ceil((o.retryAfterMs ?? 1000) / 1000),
    verb: 'Checked in',
    noun: 'check-in',
    wait: `${Math.ceil((o.cooldownRemainingMs ?? 0) / 60000)} min`,
  };
  const title =
    o.action?.id === 'undo'
      ? 'Undone'
      : ok
        ? (d?.header.title ??
          (o.action?.kind === 'check_in'
            ? SCAN_COPY.verdict.checkedIn
            : (o.action?.label ?? 'Done')))
        : line
          ? scanLine(line.headline, values)
          : 'Choose an action';
  const CustomGlyph = ok && d?.header.icon ? scanIcon(d.header.icon) : null;
  return (
    <section
      className="scan-result"
      data-kind={o.kind}
      data-phase={phase}
      data-testid="scan-result"
      aria-labelledby="scan-result-heading"
    >
      <div className="scan-result-band">
        {CustomGlyph ? <CustomGlyph aria-hidden size={32} /> : <Glyph aria-hidden size={32} />}
        <h1 id="scan-result-heading" tabIndex={-1}>
          {title}
        </h1>
        {line?.sub ? (
          <p>{scanLine(line.sub, values)}</p>
        ) : d?.header.meta ? (
          <p>{d.header.meta}</p>
        ) : null}
      </div>
      <div className="scan-result-body">
        {d?.identity.holder ? (
          <p className="scan-result-holder" dir="auto">
            {d.identity.holder}
          </p>
        ) : o.card?.title ? (
          <p className="scan-result-holder" dir="auto">
            {o.card.title}
          </p>
        ) : null}
        {o.previous ? (
          <p className="scan-card-line">
            {formatTime(o.previous.at)} · {o.previous.scannerName}
          </p>
        ) : null}
        {d && o.kind !== 'refused' ? <DisplayPanels display={d} /> : null}
        {d?.notes.staff ? <p>{d.notes.staff}</p> : null}
        {o.kind === 'refused' && d?.notes.refused ? <p>{d.notes.refused}</p> : null}
        {o.kind === 'ready' &&
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
    </section>
  );
}
