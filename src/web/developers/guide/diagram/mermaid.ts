import { type FlowSpec, isGroup, type SequenceSpec, type SequenceStep } from './spec.ts';

/** Mermaid text for the markdown twin, so an agent or a GitHub view gets the same picture as words. */

const clean = (s: string): string =>
  s
    .replace(/#/g, '#35;')
    .replace(/"/g, '#quot;')
    .replace(/;/g, '#59;')
    .replace(/\|/g, '#124;')
    .replace(/\s+/g, ' ');

const RESERVED = new Set([
  'state',
  'end',
  'note',
  'direction',
  'class',
  'classdef',
  'click',
  'style',
  'default',
  'subgraph',
  'graph',
  'flowchart',
  'participant',
  'actor',
  'loop',
  'opt',
  'alt',
  'par',
  'rect',
  'as',
]);
const mid = (id: string): string => id.replace(/-/g, '_');

function sequence(spec: SequenceSpec): string {
  const out = ['sequenceDiagram'];
  for (const a of spec.actors) out.push(`  participant ${mid(a.id)} as ${clean(a.label)}`);
  const step = (s: SequenceStep, pad: string) => {
    out.push(`${pad}${mid(s.from)}${s.reply ? '-->>' : '->>'}${mid(s.to)}: ${clean(s.label)}`);
    if (s.note) out.push(`${pad}Note over ${mid(s.from)},${mid(s.to)}: ${clean(s.note)}`);
  };
  for (const s of spec.steps) {
    if (!isGroup(s)) step(s, '  ');
    else {
      out.push(`  opt ${clean(s.group)}`);
      for (const inner of s.steps) step(inner, '    ');
      out.push('  end');
    }
  }
  return out.join('\n');
}

function flow(spec: FlowSpec): string {
  const names = new Map(spec.nodes.map((nd) => [nd.id, nd.label]));
  if (spec.mermaid === 'state') {
    const labels = [...names.values()].map((l) => l.toLowerCase());
    const plain = (id: string) => {
      const l = names.get(id) ?? '';
      return (
        /^\w+$/.test(l) &&
        !RESERVED.has(l.toLowerCase()) &&
        labels.filter((x) => x === l.toLowerCase()).length === 1
      );
    };
    const out = ['stateDiagram-v2'];
    for (const nd of spec.nodes)
      if (!plain(nd.id)) out.push(`  state "${clean(nd.label)}" as ${mid(nd.id)}`);
    const ref = (id: string) => (plain(id) ? (names.get(id) ?? id) : mid(id));
    for (const e of spec.edges) out.push(`  ${ref(e.from)} --> ${ref(e.to)}: ${clean(e.label)}`);
    return out.join('\n');
  }
  const out = ['flowchart TD'];
  for (const nd of spec.nodes) out.push(`  ${mid(nd.id)}["${clean(nd.label)}"]`);
  for (const e of spec.edges) out.push(`  ${mid(e.from)} -->|${clean(e.label)}| ${mid(e.to)}`);
  return out.join('\n');
}

export const diagramMermaid = (spec: SequenceSpec | FlowSpec): string =>
  spec.kind === 'sequence' ? sequence(spec) : flow(spec);
