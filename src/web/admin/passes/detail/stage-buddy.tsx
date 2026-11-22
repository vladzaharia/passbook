import { Buddy } from '../../../ui/index.ts';

/** Seated on the Front / Details control: waves after a create, sheds a tear after a void. */
export function StageBuddy({ stamp, minted }: { stamp: boolean; minted: boolean }) {
  if (!stamp && !minted) return undefined;
  return (
    <Buddy
      key={stamp ? 'tear' : 'wave'}
      size="sm"
      at="end"
      mood={stamp ? 'sad' : 'happy'}
      scene={stamp ? 'tear' : 'wave'}
      className="wl-pass-buddy"
    />
  );
}
