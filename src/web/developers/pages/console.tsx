import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { Gate } from '../ui/gate.tsx';
import { Head } from './more.tsx';

/** `/developers/console`: the full-page builder. Signed out, the ticket below is the whole page. */
export function ConsoleView() {
  const c = DEV_COPY.console;
  return (
    <>
      <Head title={c.title} line={c.line} />
      <div className="console-slot try" data-island="run" data-mode="console">
        <Gate title={GATE_COPY.lines.console} next={PATHS.console} docs={PATHS.reference} />
      </div>
    </>
  );
}
