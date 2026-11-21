import type { PassView } from '../../shared/pass-view/index.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { Card, CardBody } from '../ui/card-base.tsx';
import { KeyValue } from '../ui/key-value.tsx';
import { fieldRows, noteRows } from './pass-fields.ts';

/**
 * What the card's face does not show: the org's notes, then the back of the pass (terms, contact,
 * links) in its order, Expires, the upcoming events. One card for the portal and /p, the page's
 * only details; nothing at all when the back is empty. No title and no status: the card stamps a
 * voided or expired pass, the page's notice says it.
 */
export function PassDetails({
  passJson,
  view,
  locale,
  now,
  timeZone,
}: {
  passJson: Record<string, unknown>;
  view: PassView;
  locale: string;
  /** The caller's clock: the server's request clock, the portal's own. */
  now: Date;
  /** The visitor's zone; unknown on the server without one, then Expires names its zone. */
  timeZone?: string;
}) {
  // The page says the state; a back field about it (Membership status) could contradict it.
  const rows = fieldRows(
    passJson,
    { locale, now, ...(timeZone ? { timeZone } : {}) },
    'back',
  ).filter((r) => !/status/i.test(r.label));
  const notes = noteRows(passJson);
  if (!rows.length && !notes.length && !view.upcoming.length) return null;
  return (
    <Card>
      <CardBody className="flex flex-col gap-4">
        {notes.length ? (
          <div className="flex flex-col gap-3 border-b border-border pb-4 last:border-b-0 last:pb-0">
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
        {rows.length ? <KeyValue items={rows} /> : null}
        {view.upcoming.length ? (
          <div className="pc-flat">
            <Upcoming events={view.upcoming} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
