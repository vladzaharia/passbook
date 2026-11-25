import {
  DiagramError,
  flatSteps,
  isGroup,
  type SequenceGroup,
  type SequenceSpec,
  type SequenceStep,
} from './spec.ts';
import { type Drawn, esc, measure, mustFit, n, toneClass } from './svg.ts';

const PAD = 12;
const GUTTER = 36;
const PILL_H = 36;
const MIN_LANE = 150;
const LABEL = 13;
const CODE = 12;
const NOTE = 12;
const ROW = 48;
const ROW_NOTE = 76;
const GROUP_TOP = 34;
const GROUP_BOTTOM = 12;
const MAX_LABEL = 360;
const MAX_NOTE = 300;

const codeFace = (s: SequenceStep) => (s.code ? 'mono' : 'sans');
const labelW = (s: SequenceStep): number =>
  mustFit('step', s.label, s.code ? CODE : LABEL, codeFace(s), MAX_LABEL);

export function drawSequence(spec: SequenceSpec, uid: string): Drawn {
  const idx = new Map(spec.actors.map((a, i) => [a.id, i]));
  const lane = (id: string): number => idx.get(id) ?? 0;
  const pillW = spec.actors.map((a) =>
    Math.max(110, mustFit(`actor ${a.id}`, a.label, 14, 'semibold', 180) + 32),
  );
  const widest = Math.max(...pillW);
  let spacing = Math.max(MIN_LANE, widest + 20);
  for (const s of flatSteps(spec)) {
    const k = Math.abs(lane(s.from) - lane(s.to));
    spacing = Math.max(spacing, Math.ceil((labelW(s) + 30) / k));
    if (s.note) mustFit(`note "${s.note}"`, s.note, NOTE, 'sans', MAX_NOTE);
  }
  const x0 = PAD + GUTTER + widest / 2;
  const cx = (id: string): number => x0 + lane(id) * spacing;
  let right = cx(spec.actors[spec.actors.length - 1]?.id ?? '') + widest / 2;

  let y = PAD + PILL_H + 14;
  let num = 0;
  const frames: string[] = [];
  const msgs: string[] = [];
  const row = (s: SequenceStep): void => {
    num += 1;
    const a = cx(s.from);
    const b = cx(s.to);
    const dir = b > a ? 1 : -1;
    const ay = y + 28;
    const mid = (a + b) / 2;
    const cls = `dg-msg${s.reply ? ' dg-reply' : ''}`;
    let g =
      `<g class="${cls}"><circle class="dg-dot" cx="${n(a)}" cy="${n(ay)}" r="3.5"/>` +
      `<line class="dg-line${s.reply ? ' dg-dashed-line' : ''}" x1="${n(a + dir * 3)}" y1="${n(ay)}" x2="${n(b - dir * 3)}" y2="${n(ay)}" marker-end="url(#${uid}-${s.reply ? 'head-open' : 'head'})"/>` +
      `<text class="dg-label${s.code ? ' dg-code' : ''}" x="${n(mid)}" y="${n(ay - 9)}" text-anchor="middle">${esc(s.label)}</text>` +
      `<circle class="dg-num-bg" cx="${PAD + 11}" cy="${n(ay)}" r="11"/><text class="dg-num" x="${PAD + 11}" y="${n(ay + 4)}" text-anchor="middle">${num}</text>`;
    if (s.note) {
      const w = measure(s.note, NOTE, 'sans') + 24;
      const nx = mid - w / 2;
      right = Math.max(right, nx + w);
      if (nx < PAD + GUTTER)
        throw new DiagramError(`note "${s.note}" runs into the step numbers; widen the lanes`);
      g += `<rect class="dg-notebox" x="${n(nx)}" y="${n(ay + 10)}" width="${n(w)}" height="26" rx="8"/><text class="dg-notetext" x="${n(mid)}" y="${n(ay + 27)}" text-anchor="middle">${esc(s.note)}</text>`;
    }
    msgs.push(`${g}</g>`);
    y += s.note ? ROW_NOTE : ROW;
  };
  const drawGroup = (grp: SequenceGroup): void => {
    const xs = grp.steps.flatMap((s) => [cx(s.from), cx(s.to)]);
    const lo = Math.min(...xs) - 34;
    const hi = Math.max(...xs) + 34;
    y += 10;
    const top = y - 6;
    y += GROUP_TOP - 6;
    for (const s of grp.steps) row(s);
    y += GROUP_BOTTOM - 8;
    const tab = mustFit(`group "${grp.group}"`, grp.group, 12, 'semibold', 260) + 20;
    right = Math.max(right, hi);
    frames.push(
      `<g class="dg-group"><rect class="dg-frame" x="${n(lo)}" y="${n(top)}" width="${n(hi - lo)}" height="${n(y - top)}" rx="12"/>` +
        `<rect class="dg-tab" x="${n(lo + 12)}" y="${n(top + 8)}" width="${n(tab)}" height="22" rx="7"/>` +
        `<text class="dg-tabtext" x="${n(lo + 22)}" y="${n(top + 23)}">${esc(grp.group)}</text></g>`,
    );
  };
  for (const s of spec.steps) (isGroup(s) ? drawGroup : row)(s as never);

  const h = y + PAD;
  const pills = spec.actors
    .map((a, i) => {
      const w = pillW[i] ?? 110;
      const x = cx(a.id);
      return (
        `<g class="dg-actor ${toneClass(a.tone)}"><rect class="dg-box" x="${n(x - w / 2)}" y="${PAD}" width="${n(w)}" height="${PILL_H}" rx="12"/>` +
        `<text class="dg-name" x="${n(x)}" y="${PAD + 23}" text-anchor="middle">${esc(a.label)}</text></g>`
      );
    })
    .join('');
  const lifelines = spec.actors
    .map(
      (a) =>
        `<line class="dg-life" x1="${n(cx(a.id))}" y1="${PAD + PILL_H}" x2="${n(cx(a.id))}" y2="${n(h - PAD)}"/>`,
    )
    .join('');
  return {
    w: right + PAD,
    h,
    body: `<g class="dg-frames">${frames.join('')}</g><g class="dg-lifelines">${lifelines}</g><g class="dg-actors">${pills}</g><g class="dg-msgs">${msgs.join('')}</g>`,
  };
}
