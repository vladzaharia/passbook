import { Plus, X } from 'lucide-react';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import {
  Button,
  DependentSettings,
  IconButton,
  Input,
  RadioGroup,
  Select,
} from '@/web/ui/index.ts';
import { type StaffDraft, uid } from '../draft.ts';
import type { StepProps } from './step-props.ts';

const ROLES = [
  { value: 'door', label: 'Door' },
  { value: 'desk', label: 'Desk' },
  { value: 'manager', label: 'Manager' },
] as const;
const MAX_STAFF = 50;

function Person({
  person,
  onChange,
  onRemove,
}: {
  person: StaffDraft;
  onChange: (p: StaffDraft) => void;
  onRemove: () => void;
}) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface-raised p-2 pl-3">
      <span
        aria-hidden
        className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-subtle text-xs font-semibold text-accent-fg"
      >
        {person.name.trim().slice(0, 1).toUpperCase() || '?'}
      </span>
      <Input
        aria-label="Name"
        value={person.name}
        maxLength={40}
        placeholder="Name"
        autoComplete="off"
        onChange={(e) => onChange({ ...person, name: e.target.value })}
        className="min-w-0 flex-1 basis-40"
      />
      <Select
        aria-label={`Role of ${person.name || 'this person'}`}
        options={ROLES}
        value={person.role}
        className="w-36"
        onValueChange={(role) => onChange({ ...person, role: role as ScanRole })}
      />
      <IconButton
        label={`Remove ${person.name || 'person'}`}
        icon={<X aria-hidden />}
        onClick={onRemove}
      />
    </li>
  );
}

/** Who scans: anyone with the device, or staff who sign in with a PIN (shown once on Done). */
export function ScannersStep({ draft, set }: StepProps) {
  const staff = draft.scanners === 'staff';
  return (
    <div className="grid gap-6">
      <RadioGroup
        legend="Who scans"
        value={draft.scanners}
        onValueChange={(v) => set({ scanners: v === 'staff' ? 'staff' : 'anyone' })}
        options={[
          { value: 'anyone', label: 'Anyone with the device' },
          { value: 'staff', label: 'Staff sign in with a PIN' },
        ]}
      />
      <DependentSettings open={!staff}>
        <div className="max-w-xs">
          <Select
            aria-label="Anyone scans as"
            options={ROLES.filter((r) => r.value !== 'manager')}
            value={draft.as}
            onValueChange={(as) => set({ as: as === 'desk' ? 'desk' : 'door' })}
          />
        </div>
      </DependentSettings>
      <DependentSettings open={staff}>
        {draft.staff.length > 0 ? (
          <ul className="grid gap-2">
            {draft.staff.map((p) => (
              <Person
                key={p.id}
                person={p}
                onChange={(next) =>
                  set({ staff: draft.staff.map((x) => (x.id === p.id ? next : x)) })
                }
                onRemove={() => set({ staff: draft.staff.filter((x) => x.id !== p.id) })}
              />
            ))}
          </ul>
        ) : null}
        {draft.staff.length < MAX_STAFF ? (
          <div>
            <Button
              variant="outline"
              size="sm"
              iconStart={<Plus aria-hidden />}
              onClick={() =>
                set({ staff: [...draft.staff, { id: uid('s'), name: '', role: 'door' }] })
              }
            >
              Add person
            </Button>
          </div>
        ) : null}
      </DependentSettings>
    </div>
  );
}
