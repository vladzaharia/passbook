import type { CSSProperties } from 'react';
import { PAPER_SPECS } from '../../passkit/template/paper.ts';
import { sheetLayout } from '../../passkit/template/paper-geometry.ts';
import { CardBack, CardFront } from './ticket-card.tsx';
import type { TicketProps } from './ticket-parts.tsx';

/** A card's two faces side by side on an A4 or Letter sheet, with a cut mark at every corner. */
export function CardsOnSheet({ p }: { p: TicketProps }) {
  const { design } = p;
  if (!design.sheet) return null;
  const spec = PAPER_SPECS[design.size];
  const layout = sheetLayout(design.size, design.sheet);
  const { w, h } = layout.page;
  return (
    <div className="pp-hs" style={{ '--w': w, '--h': h } as CSSProperties}>
      {layout.cards.map((b, i) => (
        <div
          key={i === 0 ? 'front' : 'back'}
          className="pp-slot"
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
          {i === 0 ? <CardFront p={p} /> : <CardBack p={p} />}
        </div>
      ))}
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
      </svg>
    </div>
  );
}
