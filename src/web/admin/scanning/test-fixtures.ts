import type { ScannerSetup } from '@/shared/contracts/scan-setups.ts';

export const NOW = 1_800_000_000_000;

/** A paired, online browser scanner on one template; `over` changes any field. */
export const scannerFixture = (over: Partial<ScannerSetup> = {}): ScannerSetup => ({
  id: 's1',
  orgId: 'o1',
  mode: 'live',
  kind: 'device',
  deviceRole: 'scan',
  adminSession: false,
  adminUser: null,
  watch: null,
  name: 'Front door',
  accepts: { templateIds: ['t1'] },
  settings: {
    flow: 'auto',
    defaultActionId: null,
    roleWithoutSignIn: 'door',
    staffSignIn: false,
    letInAgain: 'anyone',
    reader: 'none',
    lookup: false,
    offline: false,
    dailyAmount: null,
  },
  timeZone: 'UTC',
  status: 'paired',
  online: true,
  pairedAt: NOW - 3_600_000,
  pairedLabel: 'Safari on iPhone',
  lastSeenAt: NOW - 60_000,
  expiresAt: null,
  staff: null,
  today: 12,
  createdAt: NOW - 86_400_000,
  ...over,
});

export const pairingFixture = (over: Record<string, unknown> = {}) => ({
  code: 'K7QH2M9XTR',
  url: 'https://passbook.mobile/scan#pair=K7QH2M9XTR',
  expiresAt: Date.now() + 600_000,
  ...over,
});

/** A template list row (TemplateSummarySchema) with one active template. */
export const templateFixture = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  orgId: 'o1',
  orgName: 'Northwind',
  slug: 'gala-ticket',
  name: 'Gala ticket',
  description: null,
  origin: 'uploaded',
  status: 'active',
  activeVersion: '1',
  styles: ['eventTicket'],
  passCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
