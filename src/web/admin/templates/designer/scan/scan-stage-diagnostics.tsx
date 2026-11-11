import { useId } from 'react';
import type { PreviewFit } from './scan-preview.ts';
import { safePreviewText } from './scan-preview-policy.ts';

export function StageDiagnostics({
  fit,
  cuts,
  phone,
  onSelect,
}: {
  fit: PreviewFit | null;
  cuts: Set<string>;
  phone: boolean;
  onSelect: (id: string | null) => void;
}) {
  const inputId = useId();
  return (
    <>
      {fit ? (
        <section className="sp-fit" aria-labelledby={inputId}>
          <h3 id={inputId}>
            Phone fit: {fit.units} of {fit.capacity} units
          </h3>
          <p>
            {fit.units <= fit.capacity
              ? 'Fits within the worst-case budget.'
              : 'Over the worst-case budget; trailing rows may be cut.'}
            {fit.headerParts.length
              ? ` Header: ${fit.headerParts.map((part) => `${part.label} ${part.units}`).join(', ')}.`
              : ''}
          </p>
          {fit.panels.length ? (
            <ul>
              {fit.panels.map((panel) => (
                <li key={panel.id}>
                  {safePreviewText(panel.id) ? panel.id : 'Panel'}: {panel.units} of 5 row units
                </li>
              ))}
            </ul>
          ) : null}
          {cuts.size ? (
            <>
              <p role="status">
                {cuts.size} {cuts.size === 1 ? 'row is' : 'rows are'} cut on this screen.
              </p>
              <ul>
                {[...cuts].map((id) => (
                  <li key={id}>
                    {phone ? (
                      `${safePreviewText(id) ? id : 'Row'}: Cut on this screen`
                    ) : (
                      <button type="button" className="sp-cut" onClick={() => onSelect(id)}>
                        {safePreviewText(id) ? id : 'Row'}: Cut on this screen
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
