/**
 * A guide is a markdown file with a small header and three directives: `{{run <snippet>}}` (a
 * snippet with an "Open in console" button), `{{show <snippet>}}` (the code alone) and
 * `{{diagram lifecycle}}`. A ```json fence tagged `run=<operationId>` is a request body the console
 * opens prefilled. Links `console:<operationId>` open the console on that operation. Plain TS: the
 * build, the checker and the tests read guides with this.
 */
export const GUIDE_STATUSES = ['ready', 'preview', 'soon'] as const;
export type GuideStatus = (typeof GUIDE_STATUSES)[number];

export interface GuideMeta {
  id: string;
  title: string;
  line: string;
  status: GuideStatus;
  /** Operations the guide uses beyond its steps', for the operation list. */
  ops: string[];
}

export type Block =
  | { kind: 'h2' | 'h3'; text: string; id: string }
  | { kind: 'p' | 'quote'; text: string }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'table'; head: string[]; rows: string[][] }
  | { kind: 'code'; lang: string; text: string; run?: string }
  | { kind: 'run' | 'show'; snippet: string }
  | { kind: 'diagram'; name: string };

export interface GuideDoc {
  meta: GuideMeta;
  blocks: Block[];
}

export class GuideError extends Error {}

export const slugify = (text: string): string =>
  text
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

function header(text: string, file: string): { meta: GuideMeta; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new GuideError(`${file}: no header (--- id, title, line, status ---)`);
  const raw: Record<string, string> = {};
  for (const line of (m[1] ?? '').split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) raw[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  for (const k of ['id', 'title', 'line', 'status'])
    if (!raw[k]) throw new GuideError(`${file}: header needs ${k}`);
  const status = raw.status as GuideStatus;
  if (!GUIDE_STATUSES.includes(status))
    throw new GuideError(`${file}: status must be ${GUIDE_STATUSES.join(', ')}`);
  const ops = (raw.ops ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    meta: {
      id: raw.id as string,
      title: raw.title as string,
      line: raw.line as string,
      status,
      ops,
    },
    body: text.slice(m[0].length),
  };
}

const cells = (row: string): string[] =>
  row
    .trim()
    .replace(/^\||\|$/g, '')
    .split('|')
    .map((c) => c.trim());

export function parseGuide(text: string, file: string): GuideDoc {
  const { meta, body } = header(text.replaceAll('\r\n', '\n'), file);
  const lines = body.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '') {
      i++;
      continue;
    }
    const fence = /^```(\w*)\s*(?:run=(\S+))?\s*$/.exec(line);
    if (fence) {
      const start = i;
      const code: string[] = [];
      for (i++; i < lines.length && !(lines[i] ?? '').startsWith('```'); i++)
        code.push(lines[i] ?? '');
      if (i >= lines.length) throw new GuideError(`${file}:${start + 1}: unclosed code fence`);
      i++;
      blocks.push({
        kind: 'code',
        lang: fence[1] || 'text',
        text: code.join('\n'),
        ...(fence[2] ? { run: fence[2] } : {}),
      });
      continue;
    }
    const directive = /^\{\{(run|show|diagram) ([\w-]+)\}\}$/.exec(line.trim());
    if (directive) {
      const [, kind, arg] = directive;
      blocks.push(
        kind === 'diagram'
          ? { kind: 'diagram', name: arg as string }
          : { kind: kind as 'run' | 'show', snippet: arg as string },
      );
      i++;
      continue;
    }
    if (line.trim().startsWith('{{'))
      throw new GuideError(`${file}:${i + 1}: unknown directive ${line.trim()}`);
    const heading = /^(#{2,3}) (.+)$/.exec(line);
    if (heading) {
      const text = heading[2] as string;
      blocks.push({ kind: heading[1] === '##' ? 'h2' : 'h3', text, id: slugify(text) });
      i++;
      continue;
    }
    if (line.startsWith('#')) throw new GuideError(`${file}:${i + 1}: use ## and ### headings`);
    if (line.startsWith('|')) {
      const rows: string[][] = [];
      for (; i < lines.length && (lines[i] ?? '').startsWith('|'); i++)
        rows.push(cells(lines[i] ?? ''));
      const [head, rule, ...rest] = rows;
      if (!head || !rule?.every((c) => /^:?-+:?$/.test(c)))
        throw new GuideError(`${file}: a table needs a header row and a --- rule`);
      blocks.push({ kind: 'table', head, rows: rest });
      continue;
    }
    const list = /^(-|\d+\.) /.exec(line);
    if (list) {
      const ordered = list[1] !== '-';
      const items: string[] = [];
      for (; i < lines.length && /^(-|\d+\.) /.test(lines[i] ?? ''); i++)
        items.push((lines[i] ?? '').replace(/^(-|\d+\.) /, ''));
      blocks.push({ kind: ordered ? 'ol' : 'ul', items });
      continue;
    }
    const para: string[] = [];
    const quote = line.startsWith('> ');
    for (
      ;
      i < lines.length &&
      (lines[i] ?? '').trim() !== '' &&
      (lines[i] ?? '').startsWith('> ') === quote &&
      !/^(```|#|\||\{\{|(-|\d+\.) )/.test(lines[i] ?? '');
      i++
    )
      para.push(quote ? (lines[i] ?? '').slice(2) : (lines[i] ?? ''));
    blocks.push({ kind: quote ? 'quote' : 'p', text: para.join(' ') });
  }
  return { meta, blocks };
}

/** Every `[text](target)` in an inline string. */
export function linksIn(text: string): { text: string; target: string }[] {
  return [...text.matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)].map((m) => ({
    text: m[1] as string,
    target: m[2] as string,
  }));
}

/** The inline text a block carries, for link and wording checks. */
export function blockTexts(b: Block): string[] {
  if (b.kind === 'p' || b.kind === 'quote' || b.kind === 'h2' || b.kind === 'h3') return [b.text];
  if (b.kind === 'ul' || b.kind === 'ol') return b.items;
  if (b.kind === 'table') return [...b.head, ...b.rows.flat()];
  return [];
}
