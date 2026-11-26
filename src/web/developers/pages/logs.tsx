import { BenchGate } from '../../workbench/bench/state.tsx';

/**
 * Logs' prerendered body in the bench frame: the signed-out state. The island replaces it once the session
 * reads the sandbox's log (`/api/v1/developer/logs`); a signed-out visitor loads neither. The listener's mark
 * goes in the frame's strip.
 */
export function LogsView() {
  return (
    <div data-island="logs">
      <BenchGate tool="logs" />
    </div>
  );
}
