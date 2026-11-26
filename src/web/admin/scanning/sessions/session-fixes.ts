import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ScanSetupCheck } from '@/shared/contracts/scan-setup-intent.ts';
import { ScanStaffSchema } from '@/shared/contracts/scanners.ts';
import { ScanningDeviceSchema } from '@/shared/contracts/scanning-sessions.ts';
import { api } from '@/web/lib/api.ts';
import { toast } from '@/web/ui/index.ts';
import { useUpdateSession } from './api.ts';
import type { SessionDetailData, SessionStaff } from './session-live.ts';

const promotable = (staff: readonly SessionStaff[]) =>
  staff.find((p) => p.disabledAt === null && p.role !== 'manager');

/**
 * One tap on a check's fix, as a write on the live session. Fixes that need a person's input open
 * the dialog or form that asks for it.
 */
export function useSessionFixes(
  s: SessionDetailData,
  staff: readonly SessionStaff[],
  open: { device: () => void; person: (role: 'manager') => void },
) {
  const client = useQueryClient();
  const update = useUpdateSession(s.id);
  const patch = useMutation({
    mutationFn: async (run: () => Promise<unknown>) => run(),
    onSuccess: () => client.invalidateQueries({ queryKey: ['admin', 'scanning'] }),
    onError: (error) => toast.error(error, 'Could not apply the fix'),
  });
  const device = (c: ScanSetupCheck) =>
    c.fix?.kind === 'device_direction'
      ? s.devices.find((d) => d.id === (c.fix as { device: string }).device)
      : undefined;
  return {
    pending: patch.isPending || update.isPending,
    namesFor: (c: ScanSetupCheck) => ({
      ...(device(c) ? { device: device(c)?.name ?? '' } : {}),
      ...(c.fix?.kind === 'add_staff' && promotable(staff)
        ? { person: promotable(staff)?.name ?? '' }
        : {}),
    }),
    apply(c: ScanSetupCheck) {
      const fix = c.fix;
      if (!fix) return;
      switch (fix.kind) {
        case 'device_direction': {
          const d = device(c);
          if (!d) return;
          patch.mutate(() =>
            api.patch(`/api/v1/scanning-sessions/${s.id}/devices/${d.id}`, ScanningDeviceSchema, {
              overrides: { ...d.overrides, direction: fix.direction },
              revision: d.configRevision,
            }),
          );
          return;
        }
        case 'add_device':
          return open.device();
        case 'add_staff': {
          const person = promotable(staff);
          if (!person) return open.person('manager');
          patch.mutate(() =>
            api.patch(
              `/api/v1/scan-staff/${encodeURIComponent(person.id)}`,
              ScanStaffSchema,
              { role: 'manager' },
              { query: { orgId: s.orgId } },
            ),
          );
          return;
        }
        case 'remove_place':
          return void update
            .mutateAsync({ zoneIds: [], revision: s.updatedAt })
            .catch((e: unknown) => toast.error(e, 'Could not apply the fix'));
        case 'track_in_out':
          return void update
            .mutateAsync({
              settings: { checkIn: { ...s.settings.checkIn, mode: 'in_out' } },
              revision: s.updatedAt,
            })
            .catch((e: unknown) => toast.error(e, 'Could not apply the fix'));
        case 'open_template':
          return;
      }
    },
  };
}
