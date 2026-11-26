import { useState } from 'react';
import { BENCH_COPY } from '../../../shared/copy/developers-bench.ts';
import { TOOL_PATH } from '../pages/toc.tsx';
import { Sheet } from '../ui/sheet.tsx';
import { useBenchKeys } from './keys.ts';
import type { BenchTool } from './switcher.tsx';
import './state.css';

const C = BENCH_COPY.shortcuts;
const go = (tool: BenchTool) => () => location.assign(TOOL_PATH[tool]);

/**
 * The bench's page-wide keys, mounted once with the strip: `g` then c / w / l / k switches tools
 * (the frame's view transition runs), `?` opens the list of every shortcut in a sheet.
 */
export function BenchKeys({ tool }: { tool: BenchTool }) {
  const [open, setOpen] = useState(false);
  const others = (Object.keys(TOOL_PATH) as BenchTool[]).filter((t) => t !== tool);
  useBenchKeys({
    help: () => setOpen(true),
    ...Object.fromEntries(others.map((t) => [`tool:${t}`, go(t)])),
  });
  if (!open) return null;
  return (
    <Sheet title={C.title} onClose={() => setOpen(false)}>
      <dl className="bench-keys">
        {C.list.map(([keys, what]) => (
          <div key={keys} className="bench-keys-r">
            <dt>
              {keys.split(' · ').map((k) => (
                <kbd key={k}>{k}</kbd>
              ))}
            </dt>
            <dd>{what}</dd>
          </div>
        ))}
      </dl>
    </Sheet>
  );
}
