import { useOptionalToolHost } from '../host/tool-host.tsx';
import { PassesTool } from '../passes/passes-tool.tsx';
import { ToolPlaceholder } from './placeholder.tsx';
import '../../admin/passes/passes.css';
import '../bench/bench.css';
import '../bench/pane.css';
import '../passes/passes.css';

/** Passes: the context's Test passes and their inspector, on the Workbench token. */
export function PassesPage() {
  return useOptionalToolHost() ? <PassesTool /> : <ToolPlaceholder tool="passes" />;
}
