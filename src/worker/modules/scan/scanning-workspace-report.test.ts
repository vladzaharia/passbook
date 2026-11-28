import { describe, expect, it } from 'vitest';
import type { ScanDeviceCapabilities } from '../../../shared/contracts/scanning-sessions.ts';
import { storedReport } from './scanning-workspace-report.ts';

const report: ScanDeviceCapabilities = {
  width: 390,
  height: 844,
  touch: true,
  camera: 'available',
  keyboard: true,
  nativeBarcode: false,
  surfaces: ['phone', 'operator'],
  preferred: 'phone',
  hardware: [{ kind: 'camera', count: 1, builtIn: true, connected: true, state: 'ready' }],
};

describe('stored device report', () => {
  it('leaves the hardware summary out until DEVICE_REPORT_HARDWARE is on', () => {
    expect(storedReport({ DEVICE_REPORT_HARDWARE: '0' }, report)).not.toHaveProperty('hardware');
    expect(storedReport({ DEVICE_REPORT_HARDWARE: '1' }, report).hardware).toHaveLength(1);
  });
});
