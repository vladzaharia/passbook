import { drawFlow } from './flow.ts';
import { diagramMermaid } from './mermaid.ts';
import { narrowList } from './narrow.ts';
import { drawSequence } from './sequence.ts';
import { type DiagramSpec, parseDiagram } from './spec.ts';
import { esc, svgShell, tierFor } from './svg.ts';

export { DiagramError, type DiagramSpec } from './spec.ts';
export { diagramMermaid, parseDiagram };

const uidOf = (name: string): string => `dg-${name.replace(/[^a-z0-9-]/g, '-')}`;

/** The wide drawing: an inline SVG that reads the portal's tokens through dev-diagram.css. */
export function diagramSvg(name: string, spec: DiagramSpec): string {
  const uid = uidOf(name);
  const drawn = spec.kind === 'sequence' ? drawSequence(spec, uid) : drawFlow(spec, uid);
  return svgShell(uid, spec.title, spec.desc, drawn);
}

/**
 * The figure the guide page embeds: the SVG, and the list that replaces it in a narrow container.
 * Same input, same bytes.
 */
export function renderDiagram(name: string, spec: DiagramSpec): string {
  const svg = diagramSvg(name, spec);
  const w = Number(/viewBox="0 0 ([\d.]+) /.exec(svg)?.[1] ?? 0);
  return (
    `<div class="dg-wrap"><figure class="dg dg-${spec.kind} dg-t${tierFor(w)}" data-diagram="${esc(name)}">` +
    `${svg}${narrowList(spec)}</figure></div>`
  );
}
