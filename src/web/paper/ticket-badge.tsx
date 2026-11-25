import type { CSSProperties } from 'react';
import { PAPER_SPECS } from '../../passkit/template/paper.ts';
import type { Box } from '../../passkit/template/paper-geometry.ts';
import { PAPER_COPY } from '../../shared/copy/print.ts';
import { badgeFront, badgeLayout } from './badge-layout.ts';
import {
  CodeMark,
  Credit,
  Photo,
  Plate,
  sheetProps,
  type TicketProps,
  Typed,
} from './ticket-parts.tsx';
import { footMeta } from './ticket-text.ts';

const at = (b: Box, extra: CSSProperties = {}): CSSProperties => ({
  left: `calc(var(--mm) * ${b.x})`,
  top: `calc(var(--mm) * ${b.y})`,
  width: `calc(var(--mm) * ${b.w})`,
  ...extra,
});
const clamp = (lines: number): CSSProperties => ({ '--lines': lines }) as unknown as CSSProperties;

function layoutOf(p: TicketProps) {
  const spec = PAPER_SPECS[p.design.size];
  return badgeLayout(spec.widthMm, spec.heightMm);
}

/** Front: the photo leads, then the name, the role and what the door needs. */
export function BadgeFront({ p }: { p: TicketProps }) {
  const { content: c } = p;
  const L = layoutOf(p);
  const f = badgeFront(c);
  return (
    <article {...sheetProps(p, 'pp-card pp-bd-front')} data-face="front">
      <Plate
        p={p}
        style={{ position: 'absolute', ...at(L.plate), height: `calc(var(--mm) * ${L.plate.h})` }}
      />
      <div className="pp-bd-kicker" style={at(L.kicker)}>
        {[c.kicker, c.brand].join(' · ')}
      </div>
      <div
        className="pp-bd-photo"
        style={{ ...at(L.photo), height: `calc(var(--mm) * ${L.photo.h})` }}
      >
        <Photo p={p} size={L.photo.w} />
      </div>
      <div
        className="pp-bd-name"
        style={at(L.name, { ...clamp(L.name.lines), fontSize: `calc(var(--mm) * ${L.name.size})` })}
      >
        {f.name}
      </div>
      {f.role ? (
        <div className="pp-bd-role" style={at(L.role)}>
          {f.role}
        </div>
      ) : null}
      <div className="pp-bd-details" style={at(L.details, clamp(L.details.lines))}>
        {f.details.map((d) => (
          <div key={d}>{d}</div>
        ))}
      </div>
    </article>
  );
}

/** Back: the code, its typed form and the card's one-line rule. */
export function BadgeBack({ p }: { p: TicketProps }) {
  const { content: c } = p;
  const L = layoutOf(p);
  const [, line] = PAPER_COPY.oneTicket(c.noun, c.once);
  return (
    <article {...sheetProps(p, 'pp-card pp-bd-back')} data-face="back">
      <div
        className="pp-bd-code"
        style={{ ...at(L.code), height: `calc(var(--mm) * ${L.code.h})` }}
      >
        <CodeMark p={p} />
      </div>
      <div className="pp-bd-note" style={at(L.note, { height: `calc(var(--mm) * ${L.note.h})` })}>
        <Typed p={p} />
        <p>{line}</p>
        {c.help.length ? <p>{c.help.slice(0, 2).join(' · ')}</p> : null}
        <div className="pp-bd-meta">
          <span>{footMeta(c, p.issued)}</span>
          <Credit mark={p.mark} />
        </div>
      </div>
    </article>
  );
}
