import { CloudUpload, type LucideIcon } from 'lucide-react';
import { SCAN_COPY } from '../../../shared/copy/scan.ts';
import { VerdictGlyph } from './verdict-glyph.tsx';

export interface VerdictBandProps {
  kind: string;
  layout: 'row' | 'stack' | 'custom';
  reason: string | null;
  phase: string | undefined;
  screen: string;
  scanId: string | null;
  title: string;
  /** The template's own line under the verdict word. */
  customLine: string | null | undefined;
  CustomGlyph: LucideIcon | null;
  noExit: boolean;
  noReentry: boolean;
  pill: 'in' | 'out' | null;
  sub: string | null | undefined;
  admit: string | null;
  holdMs: number | null | undefined;
  /** A check-in the door has saved and not yet sent: the glyph wears an upload badge. */
  saved?: boolean;
}

/** The verdict: glyph, the word, its line. A hold draws a rail that runs down. */
export function VerdictBand(p: VerdictBandProps) {
  const { CustomGlyph } = p;
  return (
    <div
      className="scan-result-band"
      data-layout={p.layout}
      data-testid="scan-verdict"
      data-kind={p.kind}
      data-reason={p.reason}
      data-phase={p.phase}
      data-screen={p.screen}
    >
      <div className="scan-glyph-row">
        {CustomGlyph ? (
          <span className="scan-custom-glyph">
            <CustomGlyph aria-hidden />
            <span className="scan-custom-badge">
              <VerdictGlyph kind="ok" />
            </span>
          </span>
        ) : p.saved ? (
          <span className="scan-saved-glyph">
            <VerdictGlyph kind={p.kind} />
            <span className="scan-saved-badge" data-testid="scan-saved-badge">
              <CloudUpload aria-hidden size={20} strokeWidth={2.5} />
            </span>
          </span>
        ) : (
          <VerdictGlyph kind={p.kind} />
        )}
      </div>
      <div className="scan-verdict-text">
        <h1 id="scan-result-heading" tabIndex={-1}>
          {p.title}
        </h1>
        {p.customLine ? <p className="scan-verdict-custom">{p.customLine}</p> : null}
        {p.noExit ? (
          <p>{SCAN_COPY.verdict.noExitSub}</p>
        ) : p.noReentry ? (
          <p>{SCAN_COPY.verdict.noReentrySub}</p>
        ) : p.pill || p.sub ? (
          <p>
            {p.pill ? (
              <span className="scan-dir-pill" data-dir={p.pill} data-testid="scan-dir-pill">
                {SCAN_COPY.direction[p.pill]}
              </span>
            ) : null}
            {p.sub}
          </p>
        ) : null}
        {p.admit ? (
          <p className="scan-admit" data-testid="scan-admit">
            {p.admit}
          </p>
        ) : null}
      </div>
      {p.holdMs ? (
        <span
          key={p.scanId}
          aria-hidden
          className="scan-hold-rail"
          style={{ animationDuration: `${p.holdMs}ms` }}
        />
      ) : null}
    </div>
  );
}
