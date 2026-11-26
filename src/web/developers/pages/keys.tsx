import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { KEYS_COPY } from '../../../shared/copy/developers-keys.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';

/** The Keys page, prerendered: the signed-out state. The `keys` island replaces it once a sandbox's session reads its keys. */
export function KeysView() {
  return (
    <div data-island="keys" className="ks-slot">
      <h1 className="h1 page-h">{KEYS_COPY.title}</h1>
      <Gate title={GATE_COPY.lines.keys} next={PATHS.keys} docs={PATHS.guides} />
    </div>
  );
}
