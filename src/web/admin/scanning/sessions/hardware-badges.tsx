import type { ReportedHardware } from '@/shared/contracts/scan-hardware.ts';
import { Badge } from '@/web/ui/index.ts';

const NAME: Record<ReportedHardware['kind'], string> = {
  camera: 'Camera',
  barcode: 'Built-in barcode reader',
  nfc: 'NFC',
  'nfc-reader': 'NFC reader',
  keyboard: 'Scanner or keyboard',
  usb: 'USB device',
  hid: 'HID device',
  serial: 'Serial scanner',
  bluetooth: 'Bluetooth device',
  display: 'Customer display',
};
const STATE: Partial<Record<ReportedHardware['state'], string>> = {
  'needs-permission': 'needs access',
  error: 'error',
  off: 'off',
};

/** The device's own hardware summary: kinds, counts and state, as the scanner's pill shows it. */
export function HardwareBadges({
  hardware,
}: {
  hardware: readonly ReportedHardware[] | undefined;
}) {
  if (!hardware?.length) return null;
  return hardware.map((h) => {
    const state = STATE[h.state];
    return (
      <Badge
        key={`${h.kind}:${h.state}:${h.builtIn}:${h.connected}`}
        tone={
          h.state === 'error' ? 'danger' : h.state === 'needs-permission' ? 'warning' : 'neutral'
        }
      >
        {NAME[h.kind]}
        {h.count > 1 ? ` ×${h.count}` : ''}
        {state ? ` · ${state}` : ''}
      </Badge>
    );
  });
}
