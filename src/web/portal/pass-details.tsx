import type { PassView } from '../../shared/pass-view/index.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { Card, CardBody, CardHeader } from '../ui/card-base.tsx';
import { KeyValue } from '../ui/key-value.tsx';
import { StatusPill } from '../ui/status-pill-base.tsx';
import { fieldRows, noteRows } from './pass-fields.ts';

/**
 * The pass's front fields in the Apple pass's order, its expiry, then its upcoming events. One
 * card for the portal and /p: the card face is a designed layout, this list is every field.
 */
export function PassDetails({
  passJson,
  view,
  state,
  title,
  locale,
  now,
  timeZone,
}: {
  passJson: Record<string, unknown>;
  view: PassView;
  /** The holder's state: a voided, expired or removed pass says so, never the pass's own "Active". */
  state: 'active' | 'voided' | 'expired' | 'removed';
  /** What the card already calls the pass: a field with that value is not repeated. */
  title?: string;
  locale: string;
  /** The caller's clock: the server's request clock, the portal's own. */
  now: Date;
  /** The visitor's zone; unknown on the server without one, then Expires names its zone. */
  timeZone?: string;
}) {
  // The badge says the state; a pass field also labelled Status would say it twice.
  const rows = fieldRows(passJson, { locale, now, ...(timeZone ? { timeZone } : {}) }).filter(
    (r) => r.label.toLowerCase() !== 'status' && r.value !== title,
  );
  const notes = noteRows(passJson);
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody className="flex flex-col gap-4">
        {notes.length ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface-page p-4">
            {notes.map((n) => (
              <div key={n.id} className="flex flex-col gap-0.5 text-sm">
                <span className="text-fg-muted">{n.label}</span>
                <span className="text-fg [overflow-wrap:anywhere] whitespace-pre-line">
                  {n.value}
                </span>
              </div>
            ))}
          </div>
        ) : null}
        <KeyValue items={[{ label: 'Status', value: <StatusPill status={state} /> }, ...rows]} />
        {view.upcoming.length ? (
          <div className="pc-flat">
            <Upcoming events={view.upcoming} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
