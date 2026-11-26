import { Building2 } from 'lucide-react';
import { useMemo } from 'react';
import type { OrgRole } from '@/shared/contracts/org-membership.ts';
import { cn } from '@/web/lib/cn.ts';
import { Combobox, type ComboboxOption } from '@/web/ui/index.ts';
import { ROLE_LABELS, ROLES, toggleRole } from '../../orgs/org-roles.ts';
import { useOrgList } from '../../orgs/queries.ts';

/** The organizations a rule may name: personal orgs and sandboxes never. `taken` are already in use. */
export function RuleOrgPicker({
  value,
  onValueChange,
  taken = [],
  id,
  ...aria
}: {
  value: string | undefined;
  onValueChange: (orgId: string) => void;
  taken?: readonly string[];
  id?: string;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: true | undefined;
}) {
  const orgs = useOrgList();
  const options = useMemo<ComboboxOption[]>(
    () =>
      (orgs.data?.items ?? [])
        .filter((o) => !o.personal && !taken.includes(o.id))
        .map((o) => ({
          value: o.id,
          label: o.name,
          icon: <Building2 aria-hidden className="size-4 shrink-0 text-fg-muted" />,
        })),
    [orgs.data, taken],
  );
  return (
    <Combobox
      id={id}
      options={options}
      value={value}
      onValueChange={onValueChange}
      placeholder="Pick an organization"
      searchPlaceholder="Search organizations"
      emptyText={orgs.isPending ? 'Loading' : 'No organizations'}
      {...aria}
    />
  );
}

/** Toggle chips for the org roles a rule needs; none picked means any role. */
export function RoleChips({
  value,
  onChange,
  label = 'Org roles',
}: {
  value: readonly OrgRole[];
  onChange: (next: OrgRole[]) => void;
  label?: string;
}) {
  return (
    <fieldset className="flex min-w-0 flex-col gap-2">
      <legend className="text-sm font-medium text-fg">{label}</legend>
      <div className="flex flex-wrap gap-1.5">
        {ROLES.map((role) => {
          const on = value.includes(role);
          return (
            <button
              key={role}
              type="button"
              aria-pressed={on}
              onClick={() => onChange(toggleRole(value, role, !on))}
              className={cn(
                'inline-flex min-h-8 items-center rounded-full border px-3 text-xs font-medium pointer-coarse:min-h-11',
                'wl-colors focus-visible:outline-2 focus-visible:outline-focus',
                on
                  ? 'border-accent bg-accent-subtle text-accent-fg'
                  : 'border-border bg-surface text-fg-muted hover:bg-state-hover-tint hover:text-fg-strong',
              )}
            >
              {ROLE_LABELS[role]}
            </button>
          );
        })}
      </div>
      <p className="text-xs text-fg-muted">
        {value.length === 0 ? 'Any role.' : 'Only these roles.'}
      </p>
    </fieldset>
  );
}

/** "Any role" or the picked roles, for a rule that exists. */
export const rolesText = (roles: readonly OrgRole[] | null): string =>
  roles && roles.length > 0 ? roles.map((r) => ROLE_LABELS[r]).join(', ') : 'Any role';
