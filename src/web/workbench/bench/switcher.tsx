import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { TOOL_PATH } from '../../developers/pages/toc.tsx';

export type BenchTool = keyof typeof TOOL_PATH;

/** The tools in tab order: the switcher's, the tree's and the tool switch's direction (transition.ts). */
export const BENCH_TOOLS: readonly BenchTool[] = DEV_COPY.workbench.map((w) => w.key);

export const toolLabel = (tool: BenchTool): string =>
  DEV_COPY.workbench.find((w) => w.key === tool)?.label ?? tool;

/**
 * The four tools as links. The current one carries the underline as its own element: it is named for
 * the view transition (`bench-indicator`), so a tool switch slides it from the old tab to the new one.
 * Below 720 px the row is a segmented bar and the underline is the lit segment.
 */
export function Switcher({ current }: { current: BenchTool }) {
  return (
    <nav className="bench-switch" aria-label={BENCH_COPY.label}>
      {DEV_COPY.workbench.map((w) => (
        <a
          key={w.key}
          href={TOOL_PATH[w.key]}
          aria-current={w.key === current ? 'page' : undefined}
        >
          {w.key === current ? <span className="bench-ind" aria-hidden="true" /> : null}
          <span className="bench-switch-t">{w.label}</span>
        </a>
      ))}
    </nav>
  );
}
