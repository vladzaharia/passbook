import { Pencil } from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { Button, Card, CardBody, CardHeader } from '@/web/ui/index.ts';
import { sessionAccepts, sessionRuleLabel } from './draft.ts';

export function SessionSummary({
  session,
  onEdit,
}: {
  session: ScanningSession;
  onEdit: () => void;
}) {
  const rows = [
    ['Accepts', sessionAccepts(session)],
    ['Admission', sessionRuleLabel(session)],
    ['On scan', session.settings.flow === 'auto' ? 'Automatic check-in' : 'Review'],
    ['Default reader', session.settings.reader === 'none' ? 'Camera' : 'Hardware scanner'],
    ['People lookup', session.settings.lookup ? 'On' : 'Off'],
    ['Time zone', session.timeZone],
  ];
  return (
    <Card>
      <CardHeader
        title="Session rules"
        actions={
          <Button size="sm" variant="ghost" iconStart={<Pencil aria-hidden />} onClick={onEdit}>
            Edit
          </Button>
        }
      />
      <CardBody>
        <dl className="grid gap-4">
          {rows.map(([label, value]) => (
            <div key={label} className="grid gap-1 text-sm">
              <dt className="text-fg-muted">{label}</dt>
              <dd className="font-medium text-fg-strong">{value}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-6 border-t border-border pt-4 text-xs text-fg-muted">
          Admission applies across devices. Device defaults can be overridden on each device.
        </p>
      </CardBody>
    </Card>
  );
}
