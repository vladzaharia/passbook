import type { ScanDeviceOverrides, ScanningDevice } from '@/shared/contracts/scanning-sessions.ts';
import { CheckboxField, DependentSettings, SwitchRow } from '@/web/ui/index.ts';

/** The scanners a customer screen can follow: the session's live scan-role devices. */
export const followable = (devices: readonly ScanningDevice[]) =>
  devices.filter((d) => !d.revoked && d.deviceRole === 'scan');

/** Which scanners of the session a customer screen shows. Off the list: every scanner. */
export function DeviceFollows({
  value,
  onChange,
  scanners,
}: {
  value: ScanDeviceOverrides;
  onChange: (v: ScanDeviceOverrides) => void;
  scanners: readonly ScanningDevice[];
}) {
  const chosen = value.follows;
  // Ids of revoked scanners stay stored but are not shown; an edit drops them.
  const known = chosen?.filter((id) => scanners.some((d) => d.id === id));
  const set = (follows: string[] | undefined) => {
    const { follows: _drop, ...rest } = value;
    onChange(follows ? { ...rest, follows } : rest);
  };
  return (
    <section className="grid gap-4 border-t border-border pt-4">
      <h2 className="text-sm font-semibold">Scanners shown</h2>
      <SwitchRow
        label="All scanners in this session"
        checked={!chosen}
        disabled={!scanners.length}
        onCheckedChange={(all) => set(all ? undefined : scanners.map((d) => d.id))}
      />
      <DependentSettings open={!!chosen}>
        <fieldset className="grid min-w-0 gap-1">
          <legend className="sr-only">Scanners shown</legend>
          {scanners.map((d) => {
            const on = known?.includes(d.id) ?? false;
            return (
              <CheckboxField
                key={d.id}
                label={d.name}
                checked={on}
                disabled={on && known?.length === 1}
                onCheckedChange={(next) =>
                  set(next ? [...(known ?? []), d.id] : (known ?? []).filter((id) => id !== d.id))
                }
              />
            );
          })}
        </fieldset>
      </DependentSettings>
    </section>
  );
}
