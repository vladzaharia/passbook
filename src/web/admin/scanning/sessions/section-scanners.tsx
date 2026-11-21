import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus } from 'lucide-react';
import { useState } from 'react';
import type { ScanRole } from '@/shared/contracts/scan.ts';
import { ScanStaffSchema, StaffPinSchema } from '@/shared/contracts/scanners.ts';
import type { ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { api } from '@/web/lib/api.ts';
import { errorMessage } from '@/web/lib/errors.ts';
import { Badge, Button, Callout, Input, RadioGroup, Select, toast } from '@/web/ui/index.ts';
import { PinList, type PinRow, roleLabel } from '../setup/pin-list.tsx';
import type { SessionStaff } from './session-live.ts';
import { RowEditor, SetupRow } from './setup-row.tsx';
import { useNewKeys } from './use-new-keys.ts';
import { useSectionEdit } from './use-section-edit.ts';

const CreatedSchema = StaffPinSchema.extend({ staff: ScanStaffSchema });
const ROLES = [
  { value: 'door', label: 'Door' },
  { value: 'desk', label: 'Desk' },
  { value: 'manager', label: 'Manager' },
] as const;

function useStaffWrites(orgId: string) {
  const client = useQueryClient();
  const refresh = () => client.invalidateQueries({ queryKey: ['admin', 'scanning', 'staff'] });
  return {
    create: useMutation({
      mutationFn: (body: { name: string; role: ScanRole }) =>
        api.post('/api/v1/scan-staff', CreatedSchema, { orgId, ...body }),
      onSuccess: refresh,
    }),
    role: useMutation({
      mutationFn: (v: { id: string; role: ScanRole }) =>
        api.patch(
          `/api/v1/scan-staff/${encodeURIComponent(v.id)}`,
          ScanStaffSchema,
          { role: v.role },
          { query: { orgId } },
        ),
      onSuccess: refresh,
      onError: (error) => toast.error(error, 'Could not change the role'),
    }),
  };
}

/** A name and a role; the PIN comes back once, in clear. */
function AddPerson({
  orgId,
  role: initial,
  onCreated,
  onCancel,
}: {
  orgId: string;
  role: ScanRole;
  onCreated: (row: PinRow) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<ScanRole>(initial);
  const { create } = useStaffWrites(orgId);
  const submit = () =>
    create.mutate(
      { name: name.trim(), role },
      {
        onSuccess: (r) =>
          onCreated({ id: r.staff.id, name: r.staff.name, role: r.staff.role, pin: r.pin }),
      },
    );
  return (
    <form
      className="mt-3 grid gap-3 rounded-lg border border-border-strong bg-surface-raised p-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) submit();
      }}
    >
      {create.isError ? <Callout tone="danger">{errorMessage(create.error)}</Callout> : null}
      <div className="flex flex-wrap items-center gap-2">
        <Input
          aria-label="Name"
          placeholder="Name"
          autoFocus
          maxLength={40}
          autoComplete="off"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-0 flex-1 basis-40"
        />
        <Select
          aria-label="Role"
          options={ROLES}
          value={role}
          className="w-36"
          onValueChange={(v) => setRole(v as ScanRole)}
        />
        <Button type="submit" size="sm" loading={create.isPending} disabled={!name.trim()}>
          Add
        </Button>
        <Button variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

/** Who scans: the sign-in mode, the org's staff with roles, and Add person. */
export function ScannersRow({
  session: s,
  staff,
  canManage,
  adding,
  setAdding,
}: {
  session: ScanningSession;
  staff: readonly SessionStaff[];
  canManage: boolean;
  adding: ScanRole | undefined;
  setAdding: (role: ScanRole | undefined) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [pins, setPins] = useState<PinRow[]>([]);
  const edit = useSectionEdit(s, () => setEditing(false));
  const { role } = useStaffWrites(s.orgId);
  const active = staff.filter((p) => p.disabledAt === null);
  const _fresh = useNewKeys(
    active.map((p) => p.id),
    staff.length > 0,
  );
  const byPin = s.settings.staffSignIn;
  const actions =
    canManage && !editing ? (
      <>
        <Button
          variant="ghost"
          size="sm"
          iconStart={<Plus aria-hidden />}
          onClick={() => setAdding('door')}
        >
          Add person
        </Button>
        <Button
          variant="ghost"
          size="sm"
          iconStart={<Pencil aria-hidden />}
          onClick={() => setEditing(true)}
        >
          Edit
        </Button>
      </>
    ) : undefined;
  return (
    <SetupRow label="Who scans" actions={actions}>
      {editing ? (
        <RowEditor
          onSave={() => void edit.save()}
          onCancel={() => setEditing(false)}
          saving={edit.saving}
          disabled={!edit.ready}
          error={edit.error}
        >
          <RadioGroup
            legend="Sign in"
            value={edit.draft.staffSignIn ? 'staff' : 'anyone'}
            onValueChange={(v) => edit.set({ staffSignIn: v === 'staff' })}
            options={[
              { value: 'anyone', label: 'Anyone with the device' },
              { value: 'staff', label: 'Staff PIN' },
            ]}
          />
          {edit.draft.staffSignIn ? null : (
            <div className="max-w-xs">
              <Select
                aria-label="Anyone scans as"
                options={ROLES.filter((r) => r.value !== 'manager')}
                value={edit.draft.roleWithoutSignIn}
                onValueChange={(v) =>
                  edit.set({ roleWithoutSignIn: v === 'desk' ? 'desk' : 'door' })
                }
              />
            </div>
          )}
        </RowEditor>
      ) : (
        <div className="grid gap-2">
          <span className="text-sm font-medium text-fg-strong">
            {byPin
              ? 'Staff PIN'
              : `Anyone, as ${s.settings.roleWithoutSignIn === 'desk' ? 'Desk' : 'Door'}`}
          </span>
          {byPin && active.length ? (
            <ul className="flex flex-wrap gap-2">
              {active.map((p) =>
                canManage ? (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 rounded-full border border-border bg-surface-raised py-1 pr-1 pl-3 text-sm"
                  >
                    <span className="text-fg-strong">{p.name}</span>
                    <Select
                      aria-label={`Role of ${p.name}`}
                      options={ROLES}
                      value={p.role}
                      className="h-7 w-28 text-xs"
                      onValueChange={(v) => role.mutate({ id: p.id, role: v as ScanRole })}
                    />
                  </li>
                ) : (
                  <li key={p.id}>
                    <Badge>
                      {p.name} · {roleLabel(p.role)}
                    </Badge>
                  </li>
                ),
              )}
            </ul>
          ) : null}
        </div>
      )}
      {adding ? (
        <AddPerson
          key={adding}
          orgId={s.orgId}
          role={adding}
          onCancel={() => setAdding(undefined)}
          onCreated={(row) => {
            setPins((p) => [...p, row]);
            setAdding(undefined);
          }}
        />
      ) : null}
      {pins.length ? (
        <div className="mt-3 grid gap-2">
          <PinList rows={pins} />
          <div>
            <Button variant="outline" size="sm" onClick={() => setPins([])}>
              Done
            </Button>
          </div>
        </div>
      ) : null}
    </SetupRow>
  );
}
