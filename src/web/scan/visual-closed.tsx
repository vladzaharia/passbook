/** The Closed screen of the visual gallery (`?visual=1&surface=closed&who=manager|staff`). */
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import type { ScanApi } from './api/scan-api.ts';
import { ClosedCard } from './boot/closed-card.tsx';
import { sessionFixture } from './boot/session.test-support.ts';
import { ScanShell } from './ui/scan-shell.tsx';

const ID = '01900000-0000-7000-8000-000000000001';
const api = { openNow: async () => ({}) } as unknown as ScanApi;

export function ClosedVisual({ who }: { who: string }) {
  const opensAt = Date.now() + 14 * 3_600_000;
  const base = sessionFixture({
    branding: { accent: '#0f766e', logo: null },
    staff: who === 'manager' ? { id: ID, name: 'Mo Lee', role: 'manager' } : null,
  });
  const session = {
    ...base,
    workspace: {
      session: {
        id: ID,
        orgId: ID,
        orgName: 'Northwind Live',
        mode: 'live',
        name: 'Membership entrance',
        status: 'active',
        timeZone: 'America/New_York',
        window: { open: false, by: 'hours', opensAt, closesAt: null },
      },
    },
  } as unknown as ScanSession;
  return (
    <ScanShell
      branding={session.branding}
      cardMode="boot"
      card={<ClosedCard session={session} api={api} refetch={async () => undefined} />}
    />
  );
}
