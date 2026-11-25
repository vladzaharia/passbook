import type { FlowEdge, FlowNode, FlowSpec } from './spec.ts';
import { DiagramError } from './spec.ts';
import { type Drawn, esc, measure, mustFit, n, toneClass } from './svg.ts';

const PAD = 12;
const NODE_PAD = 14;
const MIN_COL = 140;
const GAP_MIN = 60;
const NAME = 15;
const NOTE = 12;
const CALL = 13;
const ARROW_INSET = 4;
const MAX_NODE = 300;

interface Box {
  node: FlowNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

const heightOf = (nd: FlowNode): number => (nd.note ? 64 : 48);
const span = (nd: FlowNode): number => nd.span ?? 1;

/** Node text is measured and must fit; a column is as wide as its widest single-column node. */
function layout(spec: FlowSpec): { boxes: Map<string, Box>; gapX: number; w: number; h: number } {
  const cols = Math.max(...spec.nodes.map((nd) => nd.col + span(nd)));
  const rows = Math.max(...spec.nodes.map((nd) => nd.row)) + 1;
  const need = new Map<string, number>();
  for (const nd of spec.nodes) {
    const name = mustFit(`node ${nd.id}`, nd.label, NAME, 'semibold', MAX_NODE);
    const note = nd.note ? mustFit(`note on ${nd.id}`, nd.note, NOTE, 'sans', MAX_NODE * 2) : 0;
    need.set(nd.id, Math.max(name, note) + NODE_PAD * 2);
  }
  const colW = Array.from({ length: cols }, () => MIN_COL);
  for (const nd of spec.nodes) {
    if (span(nd) === 1) colW[nd.col] = Math.max(colW[nd.col] ?? 0, need.get(nd.id) ?? 0);
  }
  const callW = Math.max(
    0,
    ...spec.edges.filter((e) => !e.quiet).map((e) => measure(e.label, CALL, 'mono')),
  );
  const gapX = Math.max(GAP_MIN, Math.ceil(callW + 12));
  const hasVertical = spec.edges.some((e) => rowOf(spec, e.from) !== rowOf(spec, e.to));
  const gapY = hasVertical ? 120 : 56;
  const colX = colW.map((_, c) => PAD + colW.slice(0, c).reduce((a, b) => a + b, 0) + gapX * c);
  const rowH = Array.from({ length: rows }, (_, r) =>
    Math.max(0, ...spec.nodes.filter((nd) => nd.row === r).map(heightOf)),
  );
  const boxes = new Map<string, Box>();
  for (const nd of spec.nodes) {
    const x = colX[nd.col] ?? PAD;
    const last = nd.col + span(nd) - 1;
    const w = (colX[last] ?? x) + (colW[last] ?? MIN_COL) - x;
    if ((need.get(nd.id) ?? 0) > w) {
      throw new DiagramError(
        `node ${nd.id} needs ${Math.ceil(need.get(nd.id) ?? 0)}px, its columns give ${Math.floor(w)}px`,
      );
    }
    const y = PAD + rowH.slice(0, nd.row).reduce((a, b) => a + b, 0) + gapY * nd.row;
    boxes.set(nd.id, { node: nd, x, y, w, h: heightOf(nd) });
  }
  const w = PAD * 2 + colW.reduce((a, b) => a + b, 0) + gapX * (cols - 1);
  const h = PAD * 2 + rowH.reduce((a, b) => a + b, 0) + gapY * (rows - 1);
  return { boxes, gapX, w, h };
}

const rowOf = (spec: FlowSpec, id: string): number =>
  spec.nodes.find((nd) => nd.id === id)?.row ?? 0;

function drawNode(b: Box): string {
  const { node: nd } = b;
  const cls = `dg-node ${toneClass(nd.tone)}${nd.dashed ? ' dg-dashed' : ''}`;
  const cx = b.x + b.w / 2;
  const ty = nd.note ? b.y + 27 : b.y + b.h / 2 + 5;
  return (
    `<g class="${cls}"><rect class="dg-box" x="${n(b.x)}" y="${n(b.y)}" width="${n(b.w)}" height="${n(b.h)}" rx="12"/>` +
    `<text class="dg-name" x="${n(cx)}" y="${n(ty)}" text-anchor="middle">${esc(nd.label)}</text>` +
    (nd.note
      ? `<text class="dg-note" x="${n(cx)}" y="${n(b.y + 46)}" text-anchor="middle">${esc(nd.note)}</text>`
      : '') +
    '</g>'
  );
}

const lineCls = (e: FlowEdge): string => `dg-line${e.dashed ? ' dg-dashed-line' : ''}`;

/** A horizontal arrow across the gap between two boxes in one row; pairs run in two lanes. */
function drawSide(
  e: FlowEdge,
  a: Box,
  b: Box,
  lane: -1 | 0 | 1,
  gapX: number,
  uid: string,
): string {
  const right = b.x > a.x;
  const from = right ? a.x + a.w : a.x;
  const to = right ? b.x : b.x + b.w;
  const gap = Math.abs(to - from);
  if (!e.quiet) mustFit(`edge ${e.label}`, e.label, CALL, 'mono', Math.min(gap, gapX) - 8);
  const y = a.y + a.h / 2 + lane * 13;
  const mid = (from + to) / 2;
  const ty = lane === 1 ? y + 17 : y - 6;
  return (
    `<g class="dg-edge"><line class="${lineCls(e)}" x1="${n(from + (right ? ARROW_INSET : -ARROW_INSET))}" y1="${n(y)}" x2="${n(to + (right ? -ARROW_INSET : ARROW_INSET))}" y2="${n(y)}" marker-end="url(#${uid}-head)"/>` +
    (e.quiet
      ? ''
      : `<text class="dg-call" x="${n(mid)}" y="${n(ty)}" text-anchor="middle">${esc(e.label)}</text>`) +
    '</g>'
  );
}

/** A vertical arrow, drawn at the centre of whichever box sits inside the other's width. */
function drawDown(
  e: FlowEdge,
  a: Box,
  b: Box,
  uid: string,
  lane: -1 | 0 | 1,
  boxes: Map<string, Box>,
  width: number,
): string {
  const inside = (x: number, box: Box) => x >= box.x + 28 && x <= box.x + box.w - 28;
  const ca = a.x + a.w / 2;
  const cb = b.x + b.w / 2;
  const base = inside(ca, b) ? ca : inside(cb, a) ? cb : Number.NaN;
  if (Number.isNaN(base))
    throw new DiagramError(`edge "${e.label}" has no straight path: align the columns`);
  const x = base + lane * 14;
  const lo = Math.min(a.node.row, b.node.row);
  const hi = Math.max(a.node.row, b.node.row);
  for (const o of boxes.values()) {
    const r = o.node.row;
    if (o !== a && o !== b && r > lo && r < hi && x >= o.x && x <= o.x + o.w) {
      throw new DiagramError(`edge "${e.label}" runs through node "${o.node.id}"`);
    }
  }
  const down = b.y > a.y;
  const y1 = down ? a.y + a.h + ARROW_INSET : a.y - ARROW_INSET;
  const y2 = down ? b.y - ARROW_INSET : b.y + b.h + ARROW_INSET;
  const left = lane === -1;
  if (!e.quiet) {
    const room = left ? x - 10 - PAD : width - PAD - (x + 10);
    mustFit(`edge ${e.label}`, e.label, CALL, 'mono', room);
  }
  return (
    `<g class="dg-edge"><line class="${lineCls(e)}" x1="${n(x)}" y1="${n(y1)}" x2="${n(x)}" y2="${n(y2)}" marker-end="url(#${uid}-head)"/>` +
    (e.quiet
      ? ''
      : `<text class="dg-call" x="${n(left ? x - 10 : x + 10)}" y="${n((y1 + y2) / 2 + 4)}" text-anchor="${left ? 'end' : 'start'}">${esc(e.label)}</text>`) +
    '</g>'
  );
}

export function drawFlow(spec: FlowSpec, uid: string): Drawn {
  const { boxes, gapX, w, h } = layout(spec);
  const pairSeen = new Map<string, number>();
  const edges = spec.edges.map((e) => {
    const a = boxes.get(e.from);
    const b = boxes.get(e.to);
    if (!a || !b) throw new DiagramError(`edge "${e.label}" points at a missing node`);
    const key = [e.from, e.to].sort().join('|');
    const seen = pairSeen.get(key) ?? 0;
    pairSeen.set(key, seen + 1);
    const pair = spec.edges.filter((o) => [o.from, o.to].sort().join('|') === key).length;
    if (pair > 2) throw new DiagramError(`${e.from} and ${e.to} have more than two edges`);
    const lane = pair === 1 ? 0 : seen === 0 ? -1 : 1;
    if (a.node.row !== b.node.row) return drawDown(e, a, b, uid, lane, boxes, w);
    for (const o of boxes.values()) {
      const [l, r] = a.x < b.x ? [a, b] : [b, a];
      if (o !== a && o !== b && o.node.row === a.node.row && o.x >= l.x && o.x + o.w <= r.x + r.w) {
        throw new DiagramError(`edge "${e.label}" runs through node "${o.node.id}"`);
      }
    }
    return drawSide(e, a, b, lane, gapX, uid);
  });
  return {
    w,
    h,
    body: `<g class="dg-nodes">${spec.nodes.map((nd) => drawNode(boxes.get(nd.id) as Box)).join('')}</g><g class="dg-edges">${edges.join('')}</g>`,
  };
}
