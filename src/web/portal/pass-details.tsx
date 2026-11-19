import type { PassView } from '../../shared/pass-view/index.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { Card, CardBody, CardHeader } from '../ui/card-base.tsx';
import { KeyValue } from '../ui/key-value.tsx';
import { StatusPill } from '../ui/status-pill-base.tsx';
import { fieldRows } from './pass-fields.ts';

/**
 * The pass's front fields in the Apple pass's order, its expiry, then its upcoming events. One
 * card for the portal and /p: the card face is a designed layout, this list is every field.
 */
export function PassDetails({
  passJson,
  view,
  active,
  locale,
  now,
  timeZone,
}: {
  passJson: Record<string, unknown>;
  view: PassView;
  active: boolean;
  locale: string;
  /** The caller's clock: the server's request clock, the portal's own. */
  now: Date;
  /** The visitor's zone; unknown on the server without one, then Expires names its zone. */
  timeZone?: string;
}) {
  // The badge says the state; a pass field also labelled Status would say it twice.
  const rows = fieldRows(passJson, { locale, now, ...(timeZone ? { timeZone } : {}) }).filter(
    (r) => !(active && r.label.toLowerCase() === 'status'),
  );
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={
            active ? [{ label: 'Status', value: <StatusPill status="active" /> }, ...rows] : rows
          }
        />
        {view.upcoming.length ? (
          <div className="pc-flat">
            <Upcoming events={view.upcoming} />
          </div>
        ) : null}
      </CardBody>
    </Card>
  );
}
