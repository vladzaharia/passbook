import type { Mode } from '../../shared/contracts/common.ts';

export const SCANNER_COOKIE = '__Host-wallet_scan';
export const SCANNER_TOKEN = /^wls_[A-Za-z0-9]{8}_[A-Za-z0-9_-]{43}$/;

/** A paired browser device (cookie) or terminal (bearer). Reaches /api/v1/scan/* only. */
export interface ScannerAuth {
  kind: 'scanner';
  scannerId: string;
  orgId: string;
  mode: Mode;
  transport: 'cookie' | 'bearer';
  /** Cookie transport only. */
  csrfSecret: string | null;
  /** `scanners.kind`: a display never scans, a terminal always does. */
  scannerKind: 'device' | 'terminal' | 'display';
  /** `scanners.device_role`: what the device does now. Only `scan` reaches the scan routes. */
  deviceRole: 'scan' | 'customer' | 'monitor';
}
