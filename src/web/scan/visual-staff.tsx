/** The staff sign-in screen of the visual gallery (`?visual=1&surface=staff&by=pin|name`). */
import type { ScanSession } from '../../shared/contracts/scan-session.ts';
import { ApiError } from '../lib/errors.ts';
import type { ScanApi } from './api/scan-api.ts';
import { sessionFixture } from './boot/session.test-support.ts';
import { StaffPinReset } from './boot/staff-pin-reset.tsx';
import { StaffStart } from './boot/staff-start.tsx';
import { ScanShell } from './ui/scan-shell.tsx';

const api = {
  staffSignIn: async (input: { pin: string }) => {
    if (input.pin === '111111')
      throw new ApiError({
        status: 429,
        code: 'RATE_LIMITED',
        title: 'Too many wrong PINs. Try again later.',
      });
    throw new Error('Wrong PIN. 4 tries left.');
  },
  staffSignOut: async () => ({}) as ScanSession,
  staffNewPin: async () => ({ pin: '497205', session: {} as ScanSession }),
} as unknown as ScanApi;

export function StaffVisual({ by }: { by: string }) {
  const session = sessionFixture({
    state: 'staff_required',
    branding: { accent: '#0f766e', logo: null },
    staffList: [
      { id: 'a', name: 'Dana Door', role: 'door' },
      { id: 'b', name: 'Mo Lee', role: 'manager' },
    ],
  }) as ScanSession;
  return (
    <ScanShell
      branding={session.branding}
      cardMode="boot"
      card={
        <StaffStart
          session={session}
          api={api}
          refetch={async () => undefined}
          initialByName={by === 'name'}
        />
      }
    />
  );
}

export function PinResetVisual() {
  const session = sessionFixture({
    branding: { accent: '#0f766e', logo: null },
    staff: { id: 'a', name: 'Dana Door', role: 'door', pinResetRequired: true },
  }) as ScanSession;
  return (
    <ScanShell
      branding={session.branding}
      cardMode="boot"
      card={<StaffPinReset session={session} api={api} refetch={async () => undefined} />}
    />
  );
}
