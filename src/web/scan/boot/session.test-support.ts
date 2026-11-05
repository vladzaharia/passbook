/** A valid `ScanSession` for tests and stub servers. */
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { fixtureCounts } from '../machine/fixture-data.test-support.ts';

const ID = '01900000-0000-7000-8000-000000000001';

export function sessionFixture(over: Partial<ScanSession> = {}): ScanSession {
  return {
    principal: 'scanner',
    state: 'ready',
    scanner: {
      id: ID,
      name: 'Front door',
      kind: 'device',
      deviceRole: 'scan',
      mode: 'live',
      orgId: ID,
      orgName: 'Henry',
      timeZone: 'Europe/Berlin',
      settings: {
        flow: 'auto',
        defaultActionId: null,
        roleWithoutSignIn: 'door',
        staffSignIn: false,
        letInAgain: 'anyone',
        reader: 'none',
        lookup: true,
        offline: false,
        dailyAmount: null,
      },
    },
    admin: null,
    event: null,
    templates: [],
    formats: ['qr', 'pdf417', 'aztec', 'code128'],
    staff: null,
    staffList: null,
    approvals: false,
    csrfToken: 'csrf-token-1',
    undoWindowMinutes: 10,
    counts: fixtureCounts(),
    ...over,
  };
}
