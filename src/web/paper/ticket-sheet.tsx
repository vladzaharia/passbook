import { type CSSProperties, Fragment } from 'react';
import { PAPER_SPECS } from '../../passkit/template/paper.ts';
import { sheetLayout } from '../../passkit/template/paper-geometry.ts';
import { CardBack, CardFront } from './ticket-card.tsx';
import type { TicketProps } from './ticket-parts.tsx';
import { TicketStrip } from './ticket-strip.tsx';

/**
 * A holder's print on an A4 or Letter sheet at true size with cut marks. A strip is one face. A card
 * is a fold: the faces meet on the long edge; a landscape card's back is turned half a turn (a portrait card's is not: it turns on a vertical edge) so it reads upright once
 * folded, with a dashed fold line and a bleed past the cut line on the full-colour front.
 */
export function OnSheet({ p }: { p: TicketProps }) {
  const { design, content } = p;
  if (!design.sheet) return null;
  const spec = PAPER_SPECS[design.size];
  const layout = sheetLayout(design.size, design.sheet);
  const { w, h } = layout.page;
  const colour = content.ink !== 'mono';
  return (
    <div className="pp-hs" style={{ '--w': w, '--h': h } as CSSProperties}>
      {layout.faces.map((face, i) => {
        const b = face.box;
        const { top, right, bottom, left } = face.bleed;
        return (
          <Fragment key={i === 0 ? 'front' : 'back'}>
            {colour && top + right + bottom + left > 0 ? (
              <div
                className="pp-bleed"
                style={
                  {
                    '--x': b.x - left,
                    '--y': b.y - top,
                    '--cw': b.w + left + right,
                    '--ch': b.h + top + bottom,
                    background: content.colors.bg,
                  } as CSSProperties
                }
              />
            ) : null}
            <div
              className={face.rotated ? 'pp-slot pp-turned' : 'pp-slot'}
              style={
                {
                  '--x': b.x,
                  '--y': b.y,
                  '--cw': spec.widthMm,
                  '--ch': spec.heightMm,
                  '--w': spec.widthMm,
                  '--h': spec.heightMm,
                } as CSSProperties
              }
            >
              {spec.layout === 'strip' ? (
                <TicketStrip p={p} />
              ) : i === 0 ? (
                <CardFront p={p} />
              ) : (
                <CardBack p={p} />
              )}
            </div>
          </Fragment>
        );
      })}
      <svg
        className="pp-cuts"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        {layout.cuts.map(([x1, y1, x2, y2]) => (
          <line
            key={`${x1},${y1},${x2},${y2}`}
            x1={x1}
            y1={y1}
            x2={x2}
            y2={y2}
            stroke="#000"
            strokeWidth={0.2}
          />
        ))}
        {layout.fold ? (
          <line
            className="pp-fold-line"
            x1={layout.fold[0]}
            y1={layout.fold[1]}
            x2={layout.fold[2]}
            y2={layout.fold[3]}
            stroke="#9CA3B1"
            strokeWidth={0.25}
            strokeDasharray="1.2 0.8"
          />
        ) : null}
      </svg>
    </div>
  );
}
