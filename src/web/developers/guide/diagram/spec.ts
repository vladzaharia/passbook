import { z } from 'zod';

/**
 * Diagram specs: JSON in docs/developers/diagrams/<name>.json, validated here, drawn by svg.ts.
 * Two kinds. `sequence` lays itself out; `flow` sits on an explicit col/row grid.
 */
export const TONES = ['success', 'warning', 'info', 'danger', 'accent', 'neutral'] as const;
export type Tone = (typeof TONES)[number];

const id = z.string().regex(/^[a-z][a-z0-9-]*$/, 'ids are kebab-case');
const text = (max: number) => z.string().min(1).max(max);
const tone = z.enum(TONES);

const head = {
  title: text(80),
  desc: text(300),
};

const actor = z.strictObject({ id, label: text(32), tone: tone.optional() });
const step = z.strictObject({
  from: id,
  to: id,
  label: text(60),
  reply: z.boolean().optional(),
  code: z.boolean().optional(),
  note: text(80).optional(),
});
const group = z.strictObject({ group: text(40), steps: z.array(step).min(1) });

export const sequenceSpec = z.strictObject({
  ...head,
  kind: z.literal('sequence'),
  actors: z.array(actor).min(2).max(6),
  steps: z
    .array(z.union([step, group]))
    .min(1)
    .max(24),
});

const node = z.strictObject({
  id,
  label: text(32),
  note: text(80).optional(),
  tone: tone.optional(),
  col: z.number().int().min(0).max(5),
  row: z.number().int().min(0).max(7),
  span: z.number().int().min(1).max(6).optional(),
  dashed: z.boolean().optional(),
});
const edge = z.strictObject({
  from: id,
  to: id,
  label: text(24),
  quiet: z.boolean().optional(),
  dashed: z.boolean().optional(),
});

export const flowSpec = z.strictObject({
  ...head,
  kind: z.literal('flow'),
  mermaid: z.enum(['state', 'flowchart']).optional(),
  nodes: z.array(node).min(2).max(24),
  edges: z.array(edge).min(1).max(40),
});

export const diagramSpec = z.discriminatedUnion('kind', [sequenceSpec, flowSpec]);

export type SequenceStep = z.infer<typeof step>;
export type SequenceGroup = z.infer<typeof group>;
export type SequenceSpec = z.infer<typeof sequenceSpec>;
export type FlowSpec = z.infer<typeof flowSpec>;
export type FlowNode = z.infer<typeof node>;
export type FlowEdge = z.infer<typeof edge>;
export type DiagramSpec = z.infer<typeof diagramSpec>;

export class DiagramError extends Error {}

const unique = (what: string, ids: string[]) => {
  const dup = ids.find((x, i) => ids.indexOf(x) !== i);
  if (dup) throw new DiagramError(`duplicate ${what} id "${dup}"`);
};

export const isGroup = (s: SequenceStep | SequenceGroup): s is SequenceGroup => 'group' in s;

export const flatSteps = (spec: SequenceSpec): SequenceStep[] =>
  spec.steps.flatMap((s) => (isGroup(s) ? s.steps : [s]));

function checkSequence(spec: SequenceSpec): void {
  const ids = spec.actors.map((a) => a.id);
  unique('actor', ids);
  for (const s of flatSteps(spec)) {
    for (const end of [s.from, s.to]) {
      if (!ids.includes(end))
        throw new DiagramError(`step "${s.label}" names unknown actor "${end}"`);
    }
    if (s.from === s.to) throw new DiagramError(`step "${s.label}" starts and ends at ${s.from}`);
  }
}

function checkFlow(spec: FlowSpec): void {
  unique(
    'node',
    spec.nodes.map((n) => n.id),
  );
  const cells = new Set<string>();
  for (const n of spec.nodes) {
    for (let c = n.col; c < n.col + (n.span ?? 1); c++) {
      const key = `${c},${n.row}`;
      if (cells.has(key))
        throw new DiagramError(`node "${n.id}" overlaps another at col ${c}, row ${n.row}`);
      cells.add(key);
    }
  }
  const ids = new Set(spec.nodes.map((n) => n.id));
  for (const e of spec.edges) {
    for (const end of [e.from, e.to]) {
      if (!ids.has(end))
        throw new DiagramError(`edge "${e.label}" points at unknown node "${end}"`);
    }
    if (e.from === e.to) throw new DiagramError(`edge "${e.label}" loops on ${e.from}`);
  }
}

/** Parses and checks a diagram file's JSON. Throws DiagramError with the first problem. */
export function parseDiagram(json: unknown, name = 'diagram'): DiagramSpec {
  const parsed = diagramSpec.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DiagramError(
      `${name}: ${issue?.path.join('.') ?? ''} ${issue?.message ?? 'invalid'}`,
    );
  }
  const spec = parsed.data;
  try {
    if (spec.kind === 'sequence') checkSequence(spec);
    else checkFlow(spec);
  } catch (e) {
    if (e instanceof DiagramError) throw new DiagramError(`${name}: ${e.message}`);
    throw e;
  }
  return spec;
}
