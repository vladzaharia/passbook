import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';

/** The Keys tool, prerendered in the bench frame: the signed-out state. The `keys` island replaces it once a sandbox's session reads its keys. */
export function KeysView() {
  return (
    <div data-island="keys" className="ks-slot">
      <Gate title={GATE_COPY.lines.keys} next={PATHS.keys} docs={PATHS.guides} />
    </div>
  );
}
