import type { PassView } from '../../shared/pass-view/index.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { Card, CardBody } from '../ui/card-base.tsx';
import { KeyValue } from '../ui/key-value.tsx';
import { StatusPill } from '../ui/status-pill-base.tsx';
import { fieldRows, noteRows } from './pass-fields.ts';

/**
 * The pass's state, the org's notes, its front fields in the Apple pass's order, its expiry, then
 * its upcoming events: the page's one details, for the portal and /p. The card face is a designed
 * layout, this list is every field. No title and no Status label: the pill and the rows say what
 * they are.
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
      <CardBody className="flex flex-col items-start gap-4">
        <StatusPill status={state} />
        {notes.length ? (
          <div className="flex w-full flex-col gap-3 border-y border-border py-4">
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
        {rows.length ? <KeyValue items={rows} className="w-full" /> : null}
        {view.upcoming.length ? (
          <div className="pc-flat w-full">
            <Upcoming events={view.upcoming} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
