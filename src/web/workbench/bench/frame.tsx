import type { ReactNode } from 'react';
import { type BenchTool, Switcher, toolLabel } from './switcher.tsx';

/** Ids the frame owns: `tool` is where "Skip to tool" lands; the head and title are what a tool switch waits for. */
export const BENCH_IDS = { body: 'tool', head: 'bench-head', title: 'bench-title' } as const;

/**
 * The Workbench frame around a tool, prerendered: the sticky head (the switcher, then the context strip),
 * the title row (the tool's name, a count and its one primary action), the sticky toolbar and the body.
 * Every tool gets the same boxes, so the head, the h1 and the toolbar sit at the same place on all four;
 * the tools fill the slots from their islands (`data-bench-*`, bench/slots.tsx).
 *
 * The strip is the `bench-strip` island; `data-bench-status` beside it is the tool's own live mark.
 * Below 720 px the head lets go of the strip (`display: contents`), which drops under the title.
 */
export function BenchFrame({ tool, children }: { tool: BenchTool; children: ReactNode }) {
  return (
    <div className="bench" data-tool={tool}>
      <div className="bench-head" id={BENCH_IDS.head}>
        <Switcher current={tool} />
        <div className="bench-strip">
          <div className="bench-ctx" data-island="bench-strip" data-tool={tool} />
          <div className="bench-status" data-bench-status="" />
        </div>
      </div>
      <div className="bench-title" id={BENCH_IDS.title}>
        <h1 className="h1">{toolLabel(tool)}</h1>
        <span className="bench-count" data-bench-count="" />
        <div className="bench-action" data-bench-action="" />
      </div>
      <div className="bench-toolbar" data-bench-toolbar="" />
      <div className="bench-body" id={BENCH_IDS.body} tabIndex={-1}>
        {children}
      </div>
    </div>
  );
}
