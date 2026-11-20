import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import '../../lib/test-utils.tsx';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import type { ScanApi } from '../api/scan-api.ts';
import { AddPhoto, canAddPhoto } from './add-photo.tsx';

vi.mock('../../admin/passes/member-photo-file.ts', () => ({
  memberPhotoPng: async () => 'cG5n',
}));

const session = (
  scanner: { kind?: string; deviceRole?: string; settings?: Record<string, unknown> },
  staff: { role: 'door' | 'desk' | 'manager' } | null = null,
  principal: ScanSession['principal'] = 'scanner',
) =>
  ({
    principal,
    staff,
    scanner: {
      kind: 'device',
      deviceRole: 'scan',
      ...scanner,
      settings: { staffSignIn: false, roleWithoutSignIn: 'desk', ...scanner.settings },
    },
  }) as unknown as ScanSession;

describe('canAddPhoto', () => {
  it('offers Desk and up on a paired scan device', () => {
    expect(canAddPhoto(session({}))).toBe(true);
    expect(canAddPhoto(session({ settings: { staffSignIn: true } }, { role: 'manager' }))).toBe(
      true,
    );
  });
  it('hides it from Door, terminals, screens and admins', () => {
    expect(canAddPhoto(session({ settings: { roleWithoutSignIn: 'door' } }))).toBe(false);
    expect(canAddPhoto(session({ settings: { staffSignIn: true } }, { role: 'door' }))).toBe(false);
    expect(canAddPhoto(session({ kind: 'terminal' }))).toBe(false);
    expect(canAddPhoto(session({ deviceRole: 'customer' }))).toBe(false);
    expect(canAddPhoto(session({}, null, 'admin'))).toBe(false);
  });
});

describe('AddPhoto', () => {
  it('sends the cropped photo for the pass and confirms', async () => {
    const addPhoto = vi.fn().mockResolvedValue({});
    render(<AddPhoto api={{ addPhoto } as unknown as ScanApi} passId="p1" />);
    const file = new File(['x'], 'me.jpg', { type: 'image/jpeg' });
    fireEvent.change(screen.getByTestId('scan-photo-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Photo added'));
    expect(addPhoto).toHaveBeenCalledWith('p1', 'cG5n');
  });
  it('shows the failure and keeps the button', async () => {
    const addPhoto = vi.fn().mockRejectedValue(new Error('Only Desk staff can add photos.'));
    render(<AddPhoto api={{ addPhoto } as unknown as ScanApi} passId="p1" />);
    fireEvent.change(screen.getByTestId('scan-photo-input'), {
      target: { files: [new File(['x'], 'me.jpg', { type: 'image/jpeg' })] },
    });
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Only Desk staff can add photos.'),
    );
    expect(screen.getByTestId('scan-add-photo')).toBeEnabled();
  });
});
