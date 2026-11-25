import { FormField, Select, Textarea } from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES } from '../orgs/org-roles.ts';

/** A personal or platform key lives at most 90 days. */
export const SHORT_EXPIRY = [
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
];
const KINDS = [
  { value: 'service', label: 'Service: for an integration' },
  { value: 'personal', label: 'Personal: acts as you' },
];
const ACCESS = [
  { value: 'scopes', label: 'Pick scopes' },
  ...ROLES.map((role) => ({ value: role, label: `Role: ${ROLE_LABELS[role]}` })),
];

/** Type and access of an organization key, and the allowed IPs (required for a platform key). */
export function KindFields({
  orgId,
  kind,
  onKind,
  access,
  onAccess,
  ips,
  onIps,
  errors,
}: {
  orgId: string | null;
  kind: 'service' | 'personal';
  onKind: (next: 'service' | 'personal') => void;
  access: string;
  onAccess: (next: string) => void;
  ips: string;
  onIps: (next: string) => void;
  errors: Record<string, string | undefined>;
}) {
  return (
    <>
      {orgId === null ? null : (
        <FormField label="Type" error={errors.kind}>
          {(p) => (
            <Select
              {...p}
              value={kind}
              onValueChange={(next) => onKind(next === 'personal' ? 'personal' : 'service')}
              options={KINDS}
            />
          )}
        </FormField>
      )}
      {orgId === null ? null : (
        <FormField label="Access" error={errors.roles}>
          {(p) => <Select {...p} value={access} onValueChange={onAccess} options={ACCESS} />}
        </FormField>
      )}
      <FormField
        label={orgId === null ? 'Allowed IPs' : 'Allowed IPs (optional)'}
        required={orgId === null}
        error={errors.ipAllow}
      >
        {(p) => (
          <Textarea
            {...p}
            rows={2}
            autoComplete="off"
            placeholder="203.0.113.0/24"
            value={ips}
            onChange={(e) => onIps(e.target.value)}
          />
        )}
      </FormField>
    </>
  );
}
