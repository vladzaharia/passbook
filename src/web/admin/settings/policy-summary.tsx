import type { z } from 'zod';
import type { SettingsListSchema } from '@/shared/contracts/settings.ts';
import { Button, Card, CardBody, CardHeader } from '@/web/ui/index.ts';
import { PLATFORM_FIELDS } from './fields.ts';

type Entries = z.infer<typeof SettingsListSchema>['items'];

/** Saved values, not the potentially unsaved inputs in the advanced editor. */
export function PolicySummary({
  entries,
  advancedDirty,
  advancedErrors,
  onEdit,
}: {
  entries: Entries;
  advancedDirty: number;
  advancedErrors: boolean;
  onEdit: () => void;
}) {
  const value = (key: string) => entries.find((entry) => entry.key === key)?.value;
  const number = (key: string, suffix: string) => {
    const v = value(key);
    return typeof v === 'number' ? `${v} ${suffix}` : 'Unavailable';
  };
  const trust = value('oidc.trustEmail');
  const proof =
    trust === true
      ? 'Verified Polaris ID email claims trusted'
      : trust === false
        ? 'Additional email proof required for matching accounts'
        : 'Unavailable';
  const rows = [
    ['Email proof', proof],
    ['Refresh cooldown', number('refresh.userCooldownSeconds', 'seconds per pass')],
    ['Notifications', number('push.budgetPerDay', 'per pass / rolling 24 hours')],
    ['Pass versions', number('retention.passVersionsKeep', 'historical + current')],
    ['Audit retention', number('retention.auditDays', 'days')],
    ['Sync log retention', number('retention.eventsDays', 'days')],
    ['Scan retention', number('retention.scansDays', 'days')],
    ['Test data retention', number('sandbox.purgeDays', 'days')],
    ['Scan undo', number('scan.undoWindowMinutes', 'minutes')],
    ['People lookups', number('scan.lookupsPerHour', 'per scanner / hour')],
  ];
  const policies = PLATFORM_FIELDS.filter(
    (field) => field.key !== 'auth.magicLinkEnabled' && field.key !== 'email.senderName',
  ).map((field) => entries.find((entry) => entry.key === field.key));
  const defaultsKnown = policies.every((entry) => entry && entry.default !== undefined);
  const exceptions = policies.filter((entry) => entry && entry.value !== entry.default).length;
  return (
    <Card>
      <CardHeader
        title="Policy summary"
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onEdit}>
            Edit advanced policies
          </Button>
        }
      />
      <CardBody className="space-y-3">
        <p className="text-sm text-fg-muted">
          {defaultsKnown
            ? `${exceptions} advanced ${exceptions === 1 ? 'policy differs' : 'policies differ'} from the platform default.`
            : 'Some policy defaults are unavailable.'}
        </p>
        <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map(([label, text]) => (
            <div
              key={label}
              className="flex flex-wrap justify-between gap-x-3 gap-y-1 border-b border-border pb-2"
            >
              <dt className="text-fg-muted">{label}</dt>
              <dd className="text-fg-strong">{text}</dd>
            </div>
          ))}
        </dl>
        {advancedDirty > 0 ? (
          <p className="text-sm text-fg-muted">
            {advancedDirty} unsaved {advancedDirty === 1 ? 'change' : 'changes'} in Advanced.
          </p>
        ) : null}
        {advancedErrors ? (
          <p className="text-sm text-danger">Advanced policies need attention before saving.</p>
        ) : null}
      </CardBody>
    </Card>
  );
}
