import { Camera, Check } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { OPERATOR_COPY } from '../../../../shared/copy/scan-operator.ts';
import { memberPhotoPng } from '../../../admin/passes/member-photo-file.ts';
import type { ScanApi } from '../../api/scan-api.ts';
import { DisplayChip } from '../../display/chip.tsx';
import { PersonAvatar } from '../lists/person-avatar.tsx';
import type { Identity, Presence } from './record-model.ts';

const R = OPERATOR_COPY.record;

/** Dashed slot where the person's photo goes. It takes a picture itself, so P and the slot do one thing. */
export function PhotoSlot({
  api,
  passId,
  slot,
}: {
  api: ScanApi;
  passId: string;
  slot: { current: HTMLInputElement | null };
}) {
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
    <span className="op-photo">
      <input
        ref={slot}
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
      <button
        type="button"
        className="op-photo-slot"
        data-state={state}
        data-testid="scan-add-photo"
        disabled={state === 'busy' || state === 'done'}
        aria-label={state === 'done' ? 'Photo added' : 'Add photo'}
        onClick={() => slot.current?.click()}
      >
        {state === 'done' ? <Check aria-hidden /> : <Camera aria-hidden />}
      </button>
      {error ? (
        <span className="op-photo-error" role="alert">
          {error}
        </span>
      ) : null}
    </span>
  );
}

/** Who this is, and where they are now. The heading is where focus lands when a record opens. */
export function RecordIdentity({
  who,
  presence,
  photo,
}: {
  who: Identity;
  presence: Presence | null;
  /** The dashed slot, when this device may add a photo and the pass has none. */
  photo: ReactNode;
}) {
  return (
    <div className="op-ident">
      {photo ?? <PersonAvatar name={who.name} photoUrl={who.photoUrl} size="lg" />}
      <div className="op-ident-text">
        <h2 className="op-name" data-operator-heading tabIndex={-1} dir="auto" title={who.name}>
          {who.name}
        </h2>
        {who.meta ? <p className="op-ident-meta">{who.meta}</p> : null}
        {who.chips.length ? (
          <div className="op-ident-chips">
            {who.chips.map((chip) => (
              <DisplayChip key={chip.id} chip={chip} />
            ))}
          </div>
        ) : null}
      </div>
      {presence ? (
        <div className="op-presence" data-state={presence.state}>
          <span className="op-presence-k">{R.now}</span>
          <span className="op-presence-v">
            <i aria-hidden />
            {presence.state === 'in' ? R.in : presence.state === 'out' ? R.out : R.notToday}
          </span>
          {presence.line ? <span className="op-presence-s">{presence.line}</span> : null}
        </div>
      ) : null}
    </div>
  );
}
