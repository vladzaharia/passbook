import type { PassView } from '../../shared/pass-view/index.ts';
import { Upcoming } from '../pass-card/back.tsx';
import { Card, CardBody, CardHeader } from '../ui/card-base.tsx';
import { KeyValue } from '../ui/key-value.tsx';
import { StatusBadge } from '../ui/status-badge.tsx';
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
  timeZone,
}: {
  passJson: Record<string, unknown>;
  view: PassView;
  active: boolean;
  locale?: string;
  timeZone?: string;
}) {
  // The badge says the state; a pass field also labelled Status would say it twice.
  const rows = fieldRows(passJson, locale, new Date(), timeZone).filter(
    (r) => !(active && r.label.toLowerCase() === 'status'),
  );
  return (
    <Card>
      <CardHeader title="Details" />
      <CardBody className="flex flex-col gap-4">
        <KeyValue
          items={
            active ? [{ label: 'Status', value: <StatusBadge status="active" /> }, ...rows] : rows
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
