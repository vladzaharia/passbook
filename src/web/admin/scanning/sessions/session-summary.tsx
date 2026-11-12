import { Pencil } from 'lucide-react';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { Button, Card, CardBody, CardHeader } from '@/web/ui/index.ts';
import { sessionAccepts, sessionRuleLabel } from './draft.ts';

export function SessionSummary({
  session,
  onEdit,
}: {
  session: ScanningSession;
  onEdit?: (() => void) | undefined;
}) {
  const shared = [
    ['Accepts', sessionAccepts(session)],
    ['Admission', sessionRuleLabel(session)],
    ['Paired scanner staff PIN', session.settings.staffSignIn ? 'Required' : 'Not required'],
    [
      'Access without staff PIN',
      session.settings.roleWithoutSignIn === 'desk' ? 'Desk staff' : 'Check-in staff',
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
          onEdit ? (
            <Button size="sm" variant="ghost" iconStart={<Pencil aria-hidden />} onClick={onEdit}>
              Edit
            </Button>
          ) : undefined
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
          <p className="mt-3 text-xs text-fg-muted">
            Staff PINs apply only to paired, staff-operated scanners. Bearer-token terminals always
            use the access level without a staff PIN. Admin-as-scanner sessions use the signed-in
            administrator’s Manager permissions.
          </p>
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
