import { PATHS } from '../../../shared/developers.ts';
import { exampleSamples } from '../model/samples.ts';
import type { Example } from '../model/types.ts';
import { lifecycleMermaid } from './lifecycle.ts';
import { type Guide, type GuideOp, hrefOf } from './model.ts';
import type { Block } from './parse.ts';

const fenced = (lang: string, code: string) => `\`\`\`${lang}\n${code.trimEnd()}\n\`\`\``;

/** `console:<op>` becomes the operation's reference page and `/developers/...` an absolute URL. */
function link(text: string, origin: string, ops: Map<string, GuideOp>): string {
  return text.replace(/\]\(([^)\s]+)\)/g, (_, target: string) => {
    if (target.startsWith('console:'))
      return `](${origin}${ops.get(target.slice('console:'.length))?.href ?? hrefOf(target)})`;
    return `](${target.startsWith('/') ? origin + target : target})`;
  });
}

function block(
  b: Block,
  origin: string,
  ops: Map<string, GuideOp>,
  snippets: Map<string, Example>,
): string {
  switch (b.kind) {
    case 'h2':
      return `## ${b.text}`;
    case 'h3':
      return `### ${b.text}`;
    case 'p':
      return link(b.text, origin, ops);
    case 'quote':
      return `> ${link(b.text, origin, ops)}`;
    case 'ul':
      return b.items.map((i) => `- ${link(i, origin, ops)}`).join('\n');
    case 'ol':
      return b.items.map((i, n) => `${n + 1}. ${link(i, origin, ops)}`).join('\n');
    case 'table':
      return [
        `| ${b.head.join(' | ')} |`,
        `| ${b.head.map(() => '---').join(' | ')} |`,
        ...b.rows.map((r) => `| ${r.map((c) => link(c, origin, ops)).join(' | ')} |`),
      ].join('\n');
    case 'code':
      return fenced(b.lang, b.text);
    case 'diagram':
      return fenced('mermaid', lifecycleMermaid());
    case 'run':
    case 'show': {
      const e = snippets.get(b.snippet);
      if (!e) return '';
      return [
        `**${e.title}**`,
        ...exampleSamples(e).map((s) => fenced(s.lang === 'curl' ? 'sh' : s.lang, s.code)),
      ].join('\n\n');
    }
  }
}

/**
 * The guide as one markdown file for a person or an agent: the steps with their code, then every
 * operation it calls. "Copy for AI" copies it and `<guide>.md` serves it.
 */
export function guideMarkdown(guide: Guide, examples: Example[], origin: string): string {
  const ops = new Map(guide.ops.map((o) => [o.operationId, o]));
  const snippets = new Map(examples.map((e) => [e.id, e]));
  const { title, line, status } = guide.meta;
  const intro =
    status === 'soon'
      ? line
      : `${status === 'preview' ? 'Preview. ' : ''}${line}. Runs in your test sandbox: nothing is issued, every pass is a test preview. Authenticate with \`Authorization: Bearer $PASSBOOK_KEY\`. Ids in the examples are placeholders: use the ids your sandbox returns.`;
  const out = [
    `# ${title}`,
    '',
    intro,
    '',
    ...guide.blocks.flatMap((b) => [block(b, origin, ops, snippets), '']),
  ];
  if (guide.ops.length > 0) {
    out.push('## Operations', '');
    for (const o of guide.ops)
      out.push(
        `- [${o.method.toUpperCase()} ${o.path}](${origin}${o.href}): ${o.title} (\`${o.sdkCall}\`)`,
      );
    out.push('');
  }
  out.push(`More guides: ${origin}${PATHS.guides}`);
  return `${out.join('\n')}\n`;
}
