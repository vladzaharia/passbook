import { Camera, Check } from 'lucide-react';
import { useRef, useState } from 'react';
import type { ScanSession } from '../../../shared/contracts/scan-session.ts';
import { memberPhotoPng } from '../../admin/passes/member-photo-file.ts';
import { Button } from '../../ui/button.tsx';
import type { ScanApi } from '../api/scan-api.ts';

/** Desk and up on a paired scan device: the server enforces the same rule. */
export function canAddPhoto(session: ScanSession): boolean {
  const scanner = session.scanner;
  if (session.principal !== 'scanner' || !scanner) return false;
  if (scanner.kind === 'terminal' || scanner.deviceRole !== 'scan') return false;
  const role = scanner.settings.staffSignIn
    ? session.staff?.role
    : scanner.settings.roleWithoutSignIn;
  return role === 'desk' || role === 'manager';
}

/** The desk card's photo capture: the camera on a phone, a file picker elsewhere. */
export function AddPhoto({ api, passId }: { api: ScanApi; passId: string }) {
  const input = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string>();
  async function take(file: File | undefined) {
    if (!file) return;
    setState('busy');
    setError(undefined);
    try {
      await api.addPhoto(passId, await memberPhotoPng(file));
      setState('done');
    } catch (cause) {
      setState('idle');
      setError(cause instanceof Error ? cause.message : 'The photo was not saved. Try again.');
    }
  }
  return (
    <div className="scan-add-photo">
      <input
        ref={input}
        type="file"
        accept="image/*"
        capture="user"
        hidden
        data-testid="scan-photo-input"
        onChange={(e) => {
          void take(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
      {state === 'done' ? (
        <p className="scan-add-photo-done" role="status">
          <Check size={18} aria-hidden /> Photo added
        </p>
      ) : (
        <Button
          variant="outline"
          data-testid="scan-add-photo"
          disabled={state === 'busy'}
          iconStart={<Camera aria-hidden />}
          onClick={() => input.current?.click()}
        >
          {state === 'busy' ? 'Saving' : 'Add photo'}
        </Button>
      )}
      {error ? (
        <p className="scan-add-photo-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
