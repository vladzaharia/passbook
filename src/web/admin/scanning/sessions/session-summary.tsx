import { Pencil } from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { offlineModeOf } from '@/shared/scan-offline.ts';
import { zoneLabel } from '@/web/lib/timezones.ts';
import { Button, Callout, Card, CardBody, CardHeader } from '@/web/ui/index.ts';

const OFFLINE = { stop: 'Stop', decide: 'Staff decide', list: 'Offline list' } as const;

/** The rules the setup rows leave out. Edit opens the full rules dialog. */
export function SessionSummary({
  session,
  onEdit,
}: {
  session: ScanningSession;
  onEdit?: (() => void) | undefined;
}) {
  const rows = [
    ['Offline', OFFLINE[offlineModeOf(session.settings)]],
    ['Lookup', session.settings.lookup ? 'On' : 'Off'],
    ['Photos', session.settings.showPhoto === false ? 'Off' : 'On'],
    ['Time zone', zoneLabel(session.timeZone)],
  ];
  return (
    <Card>
      <CardHeader
        title="More rules"
        actions={
          onEdit ? (
            <Button size="sm" variant="ghost" iconStart={<Pencil aria-hidden />} onClick={onEdit}>
              Edit
            </Button>
          ) : undefined
        }
      />
      <CardBody className="grid gap-3">
        <dl className="grid gap-2">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-baseline justify-between gap-3 text-sm">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="text-right text-fg-strong">{value}</dd>
            </div>
          ))}
        </dl>
        {session.hoursInvalid ? (
          <Callout tone="warning">Hours could not be read. Edit and save them again.</Callout>
        ) : null}
      </CardBody>
    </Card>
  );
}
