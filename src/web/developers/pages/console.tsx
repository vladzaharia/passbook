import { BenchGate } from '../bench/state.tsx';

/** `/developers/console`, in the bench frame: the operation index and the request builder. Signed out, the gate is the whole tool. */
export function ConsoleView() {
  return (
    <div className="bench-run" data-island="console">
      <BenchGate tool="console" />
    </div>
  );
}
