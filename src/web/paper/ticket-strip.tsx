import type { CSSProperties } from 'react';
import { PAPER_SPECS } from '../../passkit/template/paper.ts';
import { paperBoxes } from '../../passkit/template/paper-geometry.ts';
import {
  CodeMark,
  Credit,
  Plate,
  sheetProps,
  type TicketProps,
  Typed,
  Watermark,
} from './ticket-parts.tsx';
import { stripText, stripType } from './ticket-strip-text.ts';
import { footMeta } from './ticket-text.ts';

/**
 * A one-row ticket (stub, boarding pass, A6, DL): the text on the pass colour at the left, the code
 * on white at the right. A compact strip (the stub) carries its typed code in the text panel.
 */
export function TicketStrip({ p }: { p: TicketProps }) {
  const { content: c, design, mode } = p;
  const spec = PAPER_SPECS[design.size];
  const boxes = paperBoxes(design.size, c.kind, { barcode: design.barcode });
  const { ticket, door } = boxes;
  const t = stripText(c, spec.heightMm, boxes.face?.w ?? 0);
  const ty = stripType(spec.heightMm);
  if (!ticket || !door) return null;
  const vars = {
    '--si': ticket.x,
    '--st': ticket.y,
    '--sw': ticket.w,
    '--sh': ticket.h,
    '--cw': door.w,
    '--sp': ty.pad,
    '--pl': ty.plate,
    '--k': ty.kicker,
    '--t': ty.title,
    '--wh': ty.when,
    '--ve': ty.venue,
    '--rl': ty.rowLabel,
    '--rv': ty.rowValue,
    '--ty': ty.typed,
    '--ft': ty.foot,
  } as CSSProperties;
  return (
    <article {...sheetProps(p, `pp-strip pp-k-${c.kind}`, vars)}>
      {mode === 'test' ? <Watermark /> : null}
      <div className="pp-st">
        <div className="pp-st-text">
          {t.compact ? (
            <div className="pp-st-k">
              {t.brand} · {t.kicker}
            </div>
          ) : (
            <div className="pp-st-head">
              <Plate p={p} />
              <div className="pp-st-who">
                <div className="pp-st-brand">{t.brand}</div>
                <div className="pp-st-k">{t.kicker}</div>
              </div>
            </div>
          )}
          <h2 className="pp-st-title">{t.title}</h2>
          {t.when ? <div className="pp-st-when">{t.when}</div> : null}
          {t.venue ? <div className="pp-st-venue">{t.venue}</div> : null}
          {t.compact ? (
            <>
              {t.rows.length ? (
                <div className="pp-st-line">{t.rows.map((r) => r.text).join(' · ')}</div>
              ) : null}
              <Typed p={p} />
            </>
          ) : t.rows.length ? (
            <div className={t.stacked ? 'pp-st-rows pp-stk' : 'pp-st-rows'}>
              {t.rows.map((r) => (
                <div className="pp-st-row" key={r.label}>
                  <div className="pp-st-rl">{r.label}</div>
                  <div className="pp-st-rv">{r.text}</div>
                </div>
              ))}
            </div>
          ) : null}
          <div className="pp-st-foot">
            <span className="pp-st-meta">{footMeta(c, p.issued)}</span>
            <Credit mark={p.mark} />
          </div>
        </div>
        <span className="pp-perf" aria-hidden="true" />
        <div className="pp-st-code">
          <CodeMark p={p} />
          {t.compact ? null : <Typed p={p} />}
        </div>
      </div>
    </article>
  );
}
