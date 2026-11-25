import type { CSSProperties } from 'react';
import { PAPER_SPECS } from '../../passkit/template/paper.ts';
import { HALF_FOOT } from '../../passkit/template/paper-geometry.ts';
import { PAPER_COPY } from '../../shared/copy/print.ts';
import { BAND, bandFit, bandTitleWidth, faceWidth } from './ticket-fit.ts';
import {
  CodeMark,
  Foot,
  Photo,
  Plate,
  Rows,
  sheetProps,
  TestStrip,
  type TicketProps,
  Typed,
  Watermark,
} from './ticket-parts.tsx';
import {
  beforeTitle,
  compactBefore,
  doorRows,
  doorWhen,
  faceLines,
  faceNotesFit,
  folds,
  infoColumns,
  rules,
} from './ticket-text.ts';
import { widestIndex } from './ticket-widths.ts';

const ART_POS = {
  artwork: '50% 30%',
  background: '50% 30%',
  thumbnail: 'right center',
  strip: 'right center',
} as const;

function Band({ p, h }: { p: TicketProps; h: number }) {
  const { content: c, assets, design } = p;
  const mono = c.ink === 'mono';
  const art = assets?.art && c.art && !mono;
  const fit = bandFit(
    c.title,
    bandTitleWidth(faceWidth(PAPER_SPECS[design.size].widthMm), c.photo),
    h,
  );
  return (
    <div
      className="pp-band"
      style={
        {
          '--art-pos': c.art ? ART_POS[c.art] : 'center',
          '--ts': fit.size,
          '--tl': fit.lines,
        } as CSSProperties
      }
    >
      {art ? (
        <>
          <img className="pp-bg" src={assets.art} alt="" />
          <span className="pp-fade" />
        </>
      ) : null}
      {c.photo ? <Photo p={p} className="pp-band-photo" size={BAND.photo} /> : null}
      <div className="pp-top">
        <Plate p={p} />
        <span className="pp-org">{c.brand}</span>
      </div>
      <div className={`pp-bottom${c.photo ? ' pp-has-photo' : ''}`}>
        <div className="pp-kicker">{c.kicker}</div>
        <h2>{c.title}</h2>
      </div>
    </div>
  );
}

/** A half sheet has no "before you go" page: a one-line version and the bring line go under the facts, and help joins the footer. */
function FaceNotes({ p }: { p: TicketProps }) {
  const { content: c } = p;
  const before = compactBefore(c);
  return (
    <>
      {before ? (
        <p className="pp-face-note">
          <b>{PAPER_COPY.before}</b> {before}
        </p>
      ) : null}
      {c.bring.length ? (
        <p className="pp-face-note">
          <b>Bring</b> {c.bring.join(' · ')}
        </p>
      ) : null}
    </>
  );
}

function Info({ p }: { p: TicketProps }) {
  const { content: c, design } = p;
  const cols = infoColumns(c);
  const wash = rules(c, design.fold);
  return (
    <div className="pp-info">
      <h2>{beforeTitle(c)}</h2>
      <div className="pp-cols" style={{ '--cols': cols.length } as CSSProperties}>
        {cols.map((col) => (
          <div className="pp-col" key={col.title}>
            <h3 className="pp-lbl">{col.title}</h3>
            {col.strong ? <p className="pp-strong">{col.strong}</p> : null}
            {col.lines?.map((l) => (
              <p key={l}>{l}</p>
            ))}
            {col.list ? (
              <ul>
                {col.list.map((li) => (
                  <li key={li} className={col.boxes ? 'pp-box' : undefined}>
                    {li}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
      <div className="pp-rules" style={{ '--rules': wash.length } as CSSProperties}>
        {wash.map(([title, text]) => (
          <p key={title}>
            <b>{title}</b>
            {text}
          </p>
        ))}
      </div>
      {c.terms ? (
        <p className="pp-terms">
          <span className="pp-lbl">Terms</span> {c.terms}
        </p>
      ) : null}
      {c.help.length ? (
        <div className="pp-support">
          <span className="pp-lbl" style={{ alignSelf: 'center' }}>
            Help
          </span>
          {c.help.map((h) => (
            <span key={h}>{h}</span>
          ))}
        </div>
      ) : null}
      <Foot p={p} />
    </div>
  );
}

/**
 * A4, Letter and the half sheet: the ticket (door panel, holder panel) on the top half, "before
 * you go" below. A half sheet is the ticket alone with its footer row under it.
 */
export function TicketFull({ p, half }: { p: TicketProps; half: boolean }) {
  const { content: c, design, mode } = p;
  const spec = PAPER_SPECS[design.size];
  const test = mode === 'test';
  const rows = doorRows(c);
  const when = doorWhen(c);
  const lines = faceLines(c, half);
  const fold = design.fold && !half && folds(c);
  const bandH = c.kind === 'pickup' ? 34 : half ? 38 : 44;
  const vars = {
    '--half': half ? spec.heightMm - HALF_FOOT : spec.heightMm / 2,
    ...(bandH === 44 ? {} : { '--band': bandH }),
  } as CSSProperties;
  return (
    <article {...sheetProps(p, `pp-k-${c.kind}`, vars)}>
      {test ? <Watermark /> : null}
      {fold ? (
        <>
          <div className="pp-fold pp-h pp-l" aria-hidden="true">
            {PAPER_COPY.fold}
          </div>
          <div className="pp-fold pp-h pp-r" aria-hidden="true">
            {PAPER_COPY.fold}
          </div>
          <div className="pp-fold pp-v pp-b" aria-hidden="true" />
        </>
      ) : null}
      <div className="pp-tk">
        <span className="pp-perf" aria-hidden="true" />
        <div className="pp-door">
          {test ? <TestStrip /> : null}
          <div className="pp-door-head">
            <Plate p={p} />
            <div className="pp-who">
              <div className="pp-org">{c.brand}</div>
              <div className="pp-title">{c.title}</div>
            </div>
          </div>
          {when ? <div className="pp-door-when">{when}</div> : null}
          <div className="pp-door-code">
            <CodeMark p={p} />
            <Typed p={p} />
          </div>
          <Rows rows={rows} />
        </div>
        <div className="pp-face">
          <Band p={p} h={bandH} />
          <div className="pp-face-body">
            <div className="pp-face-lines">
              {lines.map((l) => (
                <div key={l.text} className={l.big ? 'pp-big' : 'pp-sub'}>
                  {l.text}
                </div>
              ))}
              {half && faceNotesFit(lines) ? <FaceNotes p={p} /> : null}
            </div>
            {c.facts.length ? (
              <div className="pp-facts">
                {c.facts.map((f, i) => (
                  <div
                    className={
                      i === widestIndex(c.facts.map((x) => x.text)) ? 'pp-fact pp-wide' : 'pp-fact'
                    }
                    key={f.label}
                  >
                    <div className="pp-lbl">{f.label}</div>
                    <div className="pp-v">{f.text}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </div>
      {half ? (
        <div className="pp-info pp-info-half">
          <Foot p={p} extra={c.help.join(' · ')} />
        </div>
      ) : (
        <Info p={p} />
      )}
    </article>
  );
}
