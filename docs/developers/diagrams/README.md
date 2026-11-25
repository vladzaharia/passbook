# Diagrams

A diagram is a JSON file here, drawn by `src/web/developers/guide/diagram/` and themed by
`src/web/developers/styles/dev-diagram.css` and `dev-diagram-list.css`. Nothing is drawn by hand and no colour is written in the output:
every colour is a kit token (`--pk-*`), so light, dark and the theme toggle just work.

A guide embeds one with `{{diagram <file name>}}`. The file name is the id.

Every diagram has:

| Field | Rule |
| --- | --- |
| `title` | Up to 80 characters. Names the drawing for assistive tech. |
| `desc` | Up to 300 characters. The long description: say what the picture shows, in order. |
| `kind` | `sequence` or `flow`. |

Ids are kebab-case. Unknown keys are errors. `schema.json` is generated from the zod schema in `guide/diagram/spec.ts`
(`UPDATE_DIAGRAM_SCHEMA=1` with the diagram test rewrites it; then run `npm run format`).

## sequence

Actors across the top, steps down the page, laid out automatically. Lanes widen until every label fits.

| Field | Meaning |
| --- | --- |
| `actors[]` | 2 to 6. `id`, `label` (up to 32), `tone` optional (the one that matters gets `accent`). |
| `steps[]` | Up to 24. A step, or a group. Number badges run 1 to n in order. |
| step | `from`, `to` (actor ids, different), `label` (up to 60), `reply` (dashed, open head), `code` (monospace), `note` (up to 80, a callout under the arrow). |
| group | `{ "group": "Webhook retried", "steps": [...] }`. A labelled frame. No nesting. |

```json
{
  "title": "Issue a pass when an order completes",
  "desc": "Checkout tells your server the order completed. Your server calls POST /passes with the order id as Idempotency-Key and gets 201 with the pass.",
  "kind": "sequence",
  "actors": [
    { "id": "shop", "label": "Checkout" },
    { "id": "app", "label": "Your server" },
    { "id": "pb", "label": "PassBook", "tone": "accent" }
  ],
  "steps": [
    { "from": "shop", "to": "app", "label": "order.completed", "code": true },
    { "from": "app", "to": "pb", "label": "POST /passes", "code": true, "note": "Idempotency-Key: order id" },
    { "from": "pb", "to": "app", "label": "201 pass", "code": true, "reply": true }
  ]
}
```

A full one is `issue-on-purchase.json`.

## flow

Nodes on an explicit grid, with labelled arrows. It covers states, flows and relationships.

| Field | Meaning |
| --- | --- |
| `nodes[]` | 2 to 24. `id`, `label` (up to 32), `note` optional, `tone` optional, `col` (0 to 5), `row` (0 to 7), `span` columns (default 1), `dashed`. |
| `edges[]` | `from`, `to`, `label` (up to 24), `quiet` (draw the arrow, not the text), `dashed`. |
| `mermaid` | `state` for a state diagram, `flowchart` (default) for the twin. |

Tones: `success`, `warning`, `info`, `danger`, `accent`, `neutral` (default).

Arrows are straight. Two nodes in one row get a horizontal arrow; a pair with an edge each way gets two lanes, the
first listed on top. Nodes in different rows need columns that overlap, and get a vertical arrow. A label that
does not fit its gap, or a node whose text does not fit its columns, fails the build: shorten it or widen the span.

```json
{
  "title": "Pass lifecycle",
  "desc": "A pass is Active or Voided. void and unvoid move it between them.",
  "kind": "flow",
  "mermaid": "state",
  "nodes": [
    { "id": "voided", "label": "Voided", "note": "scans refused", "tone": "warning", "col": 0, "row": 0 },
    { "id": "active", "label": "Active", "tone": "success", "col": 1, "row": 0 }
  ],
  "edges": [
    { "from": "active", "to": "voided", "label": "void" },
    { "from": "voided", "to": "active", "label": "unvoid" }
  ]
}
```

A full one is `pass-lifecycle.json`.

## Output

`renderDiagram(name, spec)` returns one figure: the inline SVG (`role="img"`, `<title>`, `<desc>`, classes `dg-*`
only) and a list. A container query swaps them: under roughly 80% of the drawing's width the list shows. A sequence
becomes numbered steps; a flow becomes stacked cards in reading order, each with its outgoing calls. The list is also
the long description. `diagramMermaid(spec)` returns the text for the markdown twin.

Output is deterministic: the same file gives the same bytes. `guide/diagram/diagram.test.ts` checks the schema, label
fit, determinism, token-only output, contrast in both themes, and snapshots `pass-lifecycle` under `__snapshots__/`.
