import type { ScanDisplay, ScanDisplayRow } from '../../../shared/contracts/scan-display.ts';
import { SCAN_HANDHELD_COPY } from '../../../shared/copy/scan-handheld.ts';

type FactRow = Extract<ScanDisplayRow, { type: 'big' | 'columns' | 'money' | 'progress' }>;
export interface KeyFactData {
  label: string | null;
  row: FactRow;
}

const FACT = new Set(['big', 'columns', 'money', 'progress']);

/**
 * The one fact a glance card keeps: the first seat / balance / stamps row of the first panel, labelled
 * by its row or its panel. A client rule over the rendered display; the content stays the template's.
 */
export function keyFactOf(display: ScanDisplay | null): KeyFactData | null {
  const panel = display?.panels[0];
  const row = panel?.rows.find((r): r is FactRow => FACT.has(r.type));
  if (!panel || !row) return null;
  const own = row.type === 'big' || row.type === 'money' ? row.label : null;
  return { label: own ?? panel.title, row };
}

const MAX_DOTS = 12;

function Progress({ row }: { row: Extract<FactRow, { type: 'progress' }> }) {
  const done = Math.max(0, Math.min(row.value, row.goal));
  return (
    <>
      <span className="scan-keyfact-value">
        {SCAN_HANDHELD_COPY.ofGoal
          .replace('{n}', String(row.value))
          .replace('{goal}', String(row.goal))}
      </span>
      {row.goal <= MAX_DOTS ? (
        <span aria-hidden className="scan-keyfact-dots">
          {Array.from({ length: row.goal }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed run of dots
            <i key={i} data-on={i < done || undefined} />
          ))}
        </span>
      ) : (
        <span aria-hidden className="scan-keyfact-bar">
          <i style={{ width: `${(done / row.goal) * 100}%` }} />
        </span>
      )}
    </>
  );
}

/** The key fact under the identity on a glance card. */
export function KeyFact({ fact }: { fact: KeyFactData }) {
  const { row, label } = fact;
  return (
    <div className="scan-keyfact" data-type={row.type} data-testid="scan-keyfact">
      {row.type === 'columns' ? (
        row.items.map((item) => (
          <span key={item.label} className="scan-keyfact-col">
            <span className="scan-keyfact-label">{item.label}</span>
            <span className="scan-keyfact-value">{item.value}</span>
          </span>
        ))
      ) : (
        <>
          {label ? <span className="scan-keyfact-label">{label}</span> : null}
          {row.type === 'progress' ? (
            <Progress row={row} />
          ) : (
            <span
              className="scan-keyfact-value"
              data-tone={row.type === 'big' ? row.tone : undefined}
            >
              {row.type === 'money' ? row.text : row.value}
              {row.type === 'big' && row.unit ? (
                <small className="scan-keyfact-unit">{row.unit}</small>
              ) : null}
            </span>
          )}
        </>
      )}
    </div>
  );
}
