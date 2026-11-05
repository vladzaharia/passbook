import type { Mode } from '../../shared/contracts/common.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import stripCss from '../../web/ui/layout/test-strip.css?raw';
import { TestStrip } from '../../web/ui/layout/test-strip.tsx';

export const RIBBON_CSS = stripCss;

/** Under the org bar on a test pass or bundle; live pages show nothing. */
export function TestRibbon({ mode, what }: { mode: Mode | undefined; what: 'pass' | 'bundle' }) {
  if (mode !== 'test') return null;
  return <TestStrip>{HOLDER_COPY.testNote(what)}</TestStrip>;
}
