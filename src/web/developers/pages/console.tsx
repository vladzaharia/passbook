import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';

/** `/developers/console`, in the bench frame: the full-page builder. Signed out, the gate is the whole tool. */
export function ConsoleView() {
  return (
    <div className="console-slot try" data-island="run" data-mode="console">
      <Gate title={GATE_COPY.lines.console} next={PATHS.console} docs={PATHS.reference} />
    </div>
  );
}
