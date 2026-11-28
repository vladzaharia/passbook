import { GATE_COPY } from '../../../shared/copy/developers-gate.ts';
import { PATHS } from '../../../shared/developers.ts';
import { TOOL_PATH } from '../../developers/pages/toc.tsx';
import { Gate } from '../../developers/ui/gate.tsx';
import type { BenchTool } from './switcher.tsx';

/** Each tool's docs from its signed-out card (as the pages link them today). */
const GATE_DOCS: Record<BenchTool, string | undefined> = {
  console: PATHS.reference,
  webhooks: `${PATHS.reference}/webhook-endpoints`,
  logs: PATHS.reference,
  keys: PATHS.guides,
};

/** Signed out, on any tool: BX2's gate with the tool's one line and its way back after sign-in. */
export function BenchGate({ tool }: { tool: BenchTool }) {
  return <Gate title={GATE_COPY.lines[tool]} next={TOOL_PATH[tool]} docs={GATE_DOCS[tool]} />;
}
