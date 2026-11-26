import { useState } from 'react';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { ROLL_OVERLAP_HOURS } from '../../../shared/developers-keys.ts';
import { Sheet } from '../ui/sheet.tsx';
import { StepUp } from '../ui/step-up.tsx';
import { type KeyApi, KeyError, type RolledKey } from './api.ts';

const C = KEYS_COPY.rollSheet;

/** Roll or Revoke, one confirmation. Roll keeps the key's access and stops the old key after the overlap. */
export function ConfirmKeySheet({
  action,
  keyId,
  name,
  orgId,
  api,
  onRolled,
  onRevoked,
  onClose,
}: {
  action: 'roll' | 'revoke';
  keyId: string;
  name: string;
  orgId: string;
  api: KeyApi;
  onRolled: (rolled: RolledKey) => void;
  onRevoked: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [stepUp, setStepUp] = useState<string | null>(null);
  const roll = action === 'roll';
  const go = async () => {
    setBusy(true);
    setError(undefined);
    try {
      if (roll) onRolled(await api.roll(orgId, keyId, ROLL_OVERLAP_HOURS));
      else {
        await api.revoke(orgId, keyId);
        onRevoked();
      }
    } catch (e) {
      if (e instanceof KeyError && e.stepUp) setStepUp(e.signInUrl ?? '');
      else setError(e instanceof Error ? e.message : KEYS_COPY.failed);
      setBusy(false);
    }
  };
  return (
    <Sheet
      title={roll ? C.title(name) : KEYS_COPY.revokeSheet.title(name)}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn outline" onClick={onClose}>
            {KEYS_COPY.sheet.cancel}
          </button>
          <button
            type="button"
            className={roll ? 'btn' : 'btn danger'}
            disabled={busy}
            aria-busy={busy}
            onClick={() => void go()}
          >
            {roll ? C.confirm : KEYS_COPY.revokeSheet.confirm}
          </button>
        </>
      }
    >
      <div className="stack g2">
        <p className="sm">{roll ? C.line : KEYS_COPY.revokeSheet.line}</p>
        {roll ? <p className="sm muted">{C.overlap(ROLL_OVERLAP_HOURS)}</p> : null}
        {stepUp !== null ? <StepUp signInUrl={stepUp} next={`/developers/keys#${keyId}`} /> : null}
        {error ? (
          <p className="sm ks-err" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
