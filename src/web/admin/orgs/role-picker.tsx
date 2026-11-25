import type { OrgRole } from '@/shared/contracts/org-membership.ts';
import { ROLE_BLURBS, ROLE_NOTES } from '@/shared/copy/org-roles.ts';
import { cn } from '@/web/lib/cn.ts';
import { Checkbox } from '@/web/ui/index.ts';
import { exclusiveOf, ROLE_LABELS, ROLES, toggleRole } from './org-roles.ts';

export interface RolePickerProps {
  roles: readonly OrgRole[];
  onChange: (roles: OrgRole[]) => void;
  error?: string | undefined;
  idPrefix?: string;
}

/** Roles as selectable rows. Organization admin and Read only stand alone: the others grey out. */
export function RolePicker({ roles, onChange, error, idPrefix = 'role' }: RolePickerProps) {
  const exclusive = exclusiveOf(roles);
  const errorId = `${idPrefix}-error`;
  return (
    <fieldset aria-describedby={error ? errorId : undefined} className="flex flex-col gap-2">
      <legend className="mb-2 text-sm font-medium text-fg">Roles</legend>
      <div
        className={cn(
          'divide-y divide-border overflow-hidden rounded-md border',
          error ? 'border-danger' : 'border-border-strong',
        )}
      >
        {ROLES.map((role) => {
          const checked = roles.includes(role);
          const off = exclusive !== null && exclusive !== role;
          const id = `${idPrefix}-${role}`;
          return (
            <label
              key={role}
              htmlFor={id}
              data-checked={checked || undefined}
              className={cn(
                'flex min-h-11 cursor-pointer items-start gap-3 bg-surface-raised px-3 py-2.5 wl-colors',
                'hover:bg-state-hover-tint has-[:focus-visible]:outline-2 has-[:focus-visible]:-outline-offset-2 has-[:focus-visible]:outline-focus',
                checked && 'bg-accent-subtle hover:bg-accent-subtle',
                off && 'cursor-not-allowed opacity-50 hover:bg-surface-raised',
              )}
            >
              <Checkbox
                id={id}
                checked={checked}
                disabled={off}
                aria-describedby={`${id}-blurb`}
                aria-invalid={(role === ROLES[0] && Boolean(error)) || undefined}
                onCheckedChange={(value) => onChange(toggleRole(roles, role, value === true))}
                className="mt-0.5 pointer-coarse:-my-3 pointer-coarse:-ml-3"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium text-fg-strong">{ROLE_LABELS[role]}</span>
                <span id={`${id}-blurb`} className="text-xs text-fg-muted">
                  {ROLE_BLURBS[role]}
                </span>
              </span>
            </label>
          );
        })}
      </div>
      {exclusive ? (
        <p role="status" className="text-xs text-fg-muted">
          {ROLE_NOTES[exclusive]}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-xs text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}
