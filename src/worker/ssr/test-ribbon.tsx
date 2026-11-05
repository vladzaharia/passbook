import { FlaskConical } from 'lucide-react';
import type { Mode } from '../../shared/contracts/common.ts';
import { HOLDER_COPY } from '../../shared/copy/holder.ts';
import ribbonCss from './test-ribbon.css?raw';

export const RIBBON_CSS = ribbonCss;

/** Under the org bar on a test pass or bundle; live pages show nothing. */
export function TestRibbon({ mode, what }: { mode: Mode | undefined; what: 'pass' | 'bundle' }) {
  if (mode !== 'test') return null;
  return (
    <div className="tr" role="note">
      <FlaskConical aria-hidden />
      {HOLDER_COPY.testNote(what)}
    </div>
  );
}
