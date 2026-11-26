import { Server, User } from 'lucide-react';
import { FormField, Input, OptionTile, Select } from '@/web/ui/index.ts';
import type { KeyForm } from './use-key-form.ts';

const KINDS = [
  { value: 'service', label: 'Service', description: 'For an integration.', icon: Server },
  {
    value: 'personal',
    label: 'Personal',
    description: 'Acts as you. 90 days at most.',
    icon: User,
  },
] as const;

/** Name, type and expiry; the organization is fixed by the page. */
export function StepBasics({
  form,
  orgId,
  orgName,
  errors,
}: {
  form: KeyForm;
  orgId: string | null;
  orgName: string;
  errors: Record<string, string | undefined>;
}) {
  return (
    <>
      <FormField label="Name" required error={errors.name}>
        {(p) => (
          <Input
            {...p}
            data-autofocus
            autoComplete="off"
            placeholder="Box office sync"
            value={form.name}
            onChange={(e) => form.setName(e.target.value)}
          />
        )}
      </FormField>
      {orgId === null || form.cap ? null : (
        <fieldset className="flex min-w-0 flex-col">
          <legend className="mb-2 text-sm font-medium text-fg">Type</legend>
          <div className="grid gap-3 @md:grid-cols-2">
            {KINDS.map((k) => (
              <OptionTile
                key={k.value}
                name="key-kind"
                value={k.value}
                label={k.label}
                description={k.description}
                icon={k.icon}
                checked={form.kind === k.value}
                onSelect={() => form.changeKind(k.value)}
              />
            ))}
          </div>
          {errors.kind ? <p className="mt-1 text-xs text-danger">{errors.kind}</p> : null}
        </fieldset>
      )}
      <div className="grid gap-4 @md:grid-cols-2">
        <FormField label="Expires" error={errors.expiresAt}>
          {(p) => (
            <Select
              {...p}
              value={form.expiry}
              onValueChange={form.setExpiry}
              options={form.expiryOptions}
            />
          )}
        </FormField>
        <div>
          <p className="text-sm font-medium text-fg">Organization</p>
          <p className="mt-2 text-sm text-fg-strong">{orgName}</p>
          {errors.orgId ? <p className="mt-1 text-xs text-danger">{errors.orgId}</p> : null}
        </div>
      </div>
    </>
  );
}
