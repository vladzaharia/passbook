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
  const shared = [
    ['Accepts', sessionAccepts(session)],
    ['Admission', sessionRuleLabel(session)],
    [
      'Staff access',
      session.settings.staffSignIn
        ? 'Staff sign-in'
        : session.settings.roleWithoutSignIn === 'desk'
          ? 'Desk staff'
          : 'Check-in staff',
    ],
    ['Time zone', session.timeZone],
  ];
  const defaults = [
    ['On scan', session.settings.flow === 'auto' ? 'Automatic check-in' : 'Review'],
    ['Reader', session.settings.reader === 'none' ? 'Camera' : 'Hardware scanner'],
    ['People lookup', session.settings.lookup ? 'On' : 'Off'],
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
      <CardBody className="grid gap-6">
        <div>
          <h3 className="mb-3 text-xs font-semibold text-fg-muted">SHARED RULES</h3>
          <dl className="grid gap-3">
            {shared.map(([label, value]) => (
              <div key={label} className="grid gap-1 text-sm">
                <dt className="text-fg-muted">{label}</dt>
                <dd className="font-medium text-fg-strong">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div className="border-t border-border pt-4">
          <h3 className="mb-1 text-xs font-semibold text-fg-muted">DEVICE DEFAULTS</h3>
          <p className="mb-3 text-xs text-fg-muted">Can be overridden per device.</p>
          <dl className="grid gap-3">
            {defaults.map(([label, value]) => (
              <div key={label} className="grid gap-1 text-sm">
                <dt className="text-fg-muted">{label}</dt>
                <dd className="font-medium text-fg-strong">{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      </CardBody>
    </Card>
  );
}
