import { type FlowSpec, isGroup, type SequenceSpec, type SequenceStep } from './spec.ts';
import { esc, toneClass } from './svg.ts';

/** The phone layout, also the long description for assistive tech: a list that says what the picture shows. */

function sequenceList(spec: SequenceSpec): string {
  const names = new Map(spec.actors.map((a) => [a.id, a.label]));
  let num = 0;
  const item = (s: SequenceStep): string => {
    num += 1;
    return (
      `<li class="dg-step${s.reply ? ' dg-reply' : ''}"><span class="dg-n">${num}</span><div class="dg-body">` +
      `<span class="dg-who">${esc(names.get(s.from) ?? s.from)} &rarr; ${esc(names.get(s.to) ?? s.to)}</span>` +
      `<span class="dg-what${s.code ? ' dg-code' : ''}">${esc(s.label)}</span>` +
      (s.note ? `<span class="dg-aside">${esc(s.note)}</span>` : '') +
      '</div></li>'
    );
  };
  return spec.steps
    .map((s) =>
      isGroup(s)
        ? `<li class="dg-grp"><span class="dg-grp-name">${esc(s.group)}</span><ol class="dg-sub">${s.steps.map(item).join('')}</ol></li>`
        : item(s),
    )
    .join('');
}

/** Reading order for a flow: Kahn's algorithm, ties and cycles broken by grid position. */
export function flowOrder(spec: FlowSpec): string[] {
  const pos = (id: string) => {
    const nd = spec.nodes.find((x) => x.id === id);
    return (nd?.row ?? 0) * 100 + (nd?.col ?? 0);
  };
  const left = new Set(spec.nodes.map((nd) => nd.id));
  const order: string[] = [];
  while (left.size) {
    const ready = [...left].filter(
      (id) => !spec.edges.some((e) => e.to === id && left.has(e.from) && e.from !== id),
    );
    const pool = ready.length ? ready : [...left];
    const next = pool.reduce((a, b) => (pos(b) < pos(a) ? b : a));
    order.push(next);
    left.delete(next);
  }
  return order;
}

function flowList(spec: FlowSpec): string {
  const byId = new Map(spec.nodes.map((nd) => [nd.id, nd]));
  return flowOrder(spec)
    .map((id) => {
      const nd = byId.get(id);
      if (!nd) return '';
      const outs = spec.edges.filter((e) => e.from === id);
      return (
        `<li class="dg-card ${toneClass(nd.tone)}${nd.dashed ? ' dg-dashed' : ''}"><span class="dg-name">${esc(nd.label)}</span>` +
        (nd.note ? `<span class="dg-note">${esc(nd.note)}</span>` : '') +
        (outs.length
          ? `<ul class="dg-outs">${outs.map((e) => `<li><code class="dg-call">${esc(e.label)}</code><span class="dg-to">&rarr; ${esc(byId.get(e.to)?.label ?? e.to)}</span></li>`).join('')}</ul>`
          : '') +
        '</li>'
      );
    })
    .join('');
}

export function narrowList(spec: SequenceSpec | FlowSpec): string {
  const cls = spec.kind === 'sequence' ? 'dg-list dg-steps' : 'dg-list dg-cards';
  return `<ol class="${cls}" aria-label="${esc(spec.title)}">${spec.kind === 'sequence' ? sequenceList(spec) : flowList(spec)}</ol>`;
}
