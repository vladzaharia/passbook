import type { ScanDeviceOverrides, ScanningSession } from '@/shared/contracts/scanning-sessions.ts';
import { InheritSelect } from './surface-picker.tsx';

export function DeviceOverrides({
  value,
  onChange,
  session,
}: {
  value: ScanDeviceOverrides;
  onChange: (v: ScanDeviceOverrides) => void;
  session: ScanningSession;
}) {
  function set<K extends keyof ScanDeviceOverrides>(
    key: K,
    next: ScanDeviceOverrides[K] | undefined,
  ) {
    const changed = { ...value };
    if (next === undefined) delete changed[key];
    else changed[key] = next;
    onChange(changed);
  }
  return (
    <div className="grid gap-4">
      <InheritSelect
        label="On scan, tap or entered code"
        value={value.flow ?? 'inherit'}
        sessionLabel={session.settings.flow === 'auto' ? 'Automatic check-in' : 'Review'}
        options={[
          { value: 'auto', label: 'Check in automatically' },
          { value: 'choose', label: 'Review before check-in' },
        ]}
        onChange={(v) => set('flow', v === 'inherit' ? undefined : (v as 'auto' | 'choose'))}
      />
      <InheritSelect
        label="Reader"
        value={value.reader ?? 'inherit'}
        sessionLabel={session.settings.reader === 'none' ? 'Camera' : 'Hardware scanner'}
        options={[
          { value: 'none', label: 'Camera' },
          { value: 'barcode', label: 'Hardware / keyboard scanner' },
        ]}
        onChange={(v) => set('reader', v === 'inherit' ? undefined : (v as 'none' | 'barcode'))}
      />
      <InheritSelect
        label="Direction"
        value={value.direction ?? 'inherit'}
        sessionLabel={
          session.settings.direction === 'out'
            ? 'Exit'
            : session.settings.direction === 'in'
              ? 'Entry'
              : 'Automatic'
        }
        options={[
          { value: 'in', label: 'Entry only' },
          { value: 'out', label: 'Exit only' },
          { value: 'both', label: 'Automatic in / out' },
        ]}
        onChange={(v) =>
          set('direction', v === 'inherit' ? undefined : (v as 'in' | 'out' | 'both'))
        }
      />
      {(['lookup', 'showPhoto'] as const).map((key) => (
        <InheritSelect
          key={key}
          label={key === 'lookup' ? 'Look up people' : 'Member photos'}
          value={value[key] === undefined ? 'inherit' : value[key] ? 'on' : 'off'}
          sessionLabel={(session.settings[key] ?? true) ? 'On' : 'Off'}
          options={[
            { value: 'on', label: 'On' },
            { value: 'off', label: 'Off' },
          ]}
          onChange={(v) => set(key, v === 'inherit' ? undefined : v === 'on')}
        />
      ))}
    </div>
  );
}
