import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { PATHS } from '../../../shared/developers.ts';
import { loadSession } from '../console/session.ts';
import { loadRail } from './rail.ts';
import { BudgetMeter, type SandboxActivity, SandboxChip } from './sandbox-chip.tsx';
import type { BenchTool } from './switcher.tsx';

const C = BENCH_COPY.strip;

/** What the strip knows: nothing to show (signed out, or the sandbox did not read), no sandbox, or the sandbox in use. */
export type StripModel =
  | { kind: 'hidden' }
  | { kind: 'none' | 'closed' }
  | {
      kind: 'ready';
      slug: string;
      orgId: string;
      mode: 'test' | 'live';
      key: { id: string; name: string; prefix: string } | null;
    };

/** The session, and on every tool but the console (which runs on a try token, never a key) the key in use. */
export async function stripModel(tool: BenchTool): Promise<StripModel> {
  const session = await loadSession();
  if (session.kind === 'out' || session.kind === 'failed') return { kind: 'hidden' };
  if (session.kind !== 'ready') return { kind: session.kind };
  const rail = tool === 'console' ? null : (await loadRail()).body;
  return {
    kind: 'ready',
    slug: session.sandbox.orgSlug,
    orgId: session.sandbox.orgId,
    mode: rail?.mode === 'live' ? 'live' : 'test',
    key: rail?.key ? { id: rail.key.id, name: rail.key.name, prefix: rail.key.prefix } : null,
  };
}

/**
 * The context strip in the bench head: the mode, the sandbox (its chip and menu), the key in use and,
 * on the console, the Run budget. The tool's live mark sits after it (`data-bench-status`). Below 720 px
 * it is one line under the title.
 */
export function ContextStrip({
  tool,
  model,
  activity,
}: {
  tool: BenchTool;
  model: StripModel;
  /** A running operation on the sandbox (OP-2's `useActiveOperation`). */
  activity?: SandboxActivity;
}) {
  if (model.kind === 'hidden') return null;
  if (model.kind !== 'ready') return <SandboxChip variant="strip" state={{ kind: model.kind }} />;
  const live = model.mode === 'live';
  return (
    <div className="bench-ctx-row">
      <span className={`pill ${live ? 'accent' : 'info'} bench-mode`}>
        {live ? C.live : C.test}
      </span>
      <SandboxChip variant="strip" state={{ kind: 'ready', slug: model.slug, activity }} />
      {tool === 'console' ? (
        <span className="bench-key" title={C.runHereHint}>
          {C.runHere}
        </span>
      ) : model.key ? (
        <a
          className="bench-key"
          href={`${PATHS.logs}?key=${encodeURIComponent(model.key.id)}`}
          title={C.keyCalls(model.key.name)}
        >
          <span className="bench-key-n">{model.key.name}</span>
          <code className="mono">{model.key.prefix}…</code>
        </a>
      ) : null}
      {tool === 'console' ? <BudgetMeter /> : null}
    </div>
  );
}
