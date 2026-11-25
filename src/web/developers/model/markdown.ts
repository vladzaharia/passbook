import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { opUrl, PATHS, twin } from '../../../shared/developers.ts';
import { groupByStep } from '../guide/group.ts';
import type { Guide } from '../guide/model.ts';
import { operations } from './dates.ts';
import { samplesFor } from './samples.ts';
import type { Field, OpView, ResourcePage, Site } from './types.ts';

export const pagePath = (page: ResourcePage) => `${PATHS.reference}/${page.slug}`;

/** An operation's own page: `/developers/reference/passes/create`, `…/passes/memberphoto-get`. */
export const opPath = (page: ResourcePage, op: OpView) => opUrl(page.slug, op.anchor);

const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const fenced = (lang: string, code: string) => `\`\`\`${lang}\n${code}\n\`\`\``;

function fieldRows(fields: Field[], depth = 0): string[] {
  return fields.flatMap((f) => [
    `| ${'· '.repeat(depth)}\`${f.name}\` | ${f.where} | ${cell(f.type)} | ${f.required ? 'yes' : ''} | ${cell(f.description)} |`,
    ...fieldRows(f.children, depth + 1),
  ]);
}

function opMarkdown(op: OpView, base: string, level = 2): string {
  const out = [
    `${'#'.repeat(level)} ${op.title} {#${op.anchor}}`,
    '',
    `\`${op.method.toUpperCase()} ${op.path}\``,
  ];
  if (op.description) out.push('', op.description);
  const facts = [
    ...(op.scopes.length > 0 ? [`Scopes: ${op.scopes.map((s) => `\`${s}\``).join(', ')}`] : []),
    ...(op.idempotent ? ['Idempotent with an `Idempotency-Key` header'] : []),
    `SDK name: \`${op.sdkCall}\``,
  ];
  out.push('', `${facts.join('. ')}.`);
  if (op.fields.length > 0) {
    out.push(
      '',
      '| Name | In | Type | Required | Description |',
      '| --- | --- | --- | --- | --- |',
    );
    out.push(...fieldRows(op.fields));
  }
  if (op.returns)
    out.push(
      '',
      `Returns \`${op.returns.status}\`${op.returns.schema ? `, a \`${op.returns.schema}\`` : ''}.`,
    );
  if (op.errors.length > 0) {
    out.push('', '| Code | Status | Fix |', '| --- | --- | --- |');
    for (const e of op.errors) out.push(`| \`${e.code}\` | ${e.status ?? ''} | ${cell(e.fix)} |`);
  }
  const curl = samplesFor(op, base)[0];
  if (curl) out.push('', fenced('sh', curl.code));
  if (op.returns?.example !== undefined)
    out.push(
      '',
      'Response example:',
      '',
      fenced('json', JSON.stringify(op.returns.example, null, 2)),
    );
  return out.join('\n');
}

export function pageMarkdown(page: ResourcePage, site: Site): string {
  const out = [
    `# ${page.label}`,
    '',
    `${page.group} · PassBook API reference. Authenticate with \`Authorization: Bearer $PASSBOOK_KEY\`.`,
  ];
  for (const op of page.ops) out.push('', opMarkdown(op, site.baseUrl));
  if (page.consoleOnly.length > 0) {
    out.push(
      '',
      '## Console only',
      '',
      'Signed-in console sessions only; an API key cannot call these.',
      '',
    );
    for (const c of page.consoleOnly)
      out.push(`- \`${c.method.toUpperCase()} ${c.path}\`: ${c.title}`);
  }
  return `${out.join('\n')}\n`;
}

/** One operation's twin: its page as markdown, under the resource's heading. */
export function opPageMarkdown(page: ResourcePage, op: OpView, site: Site): string {
  return `${[
    `${page.group} · [${page.label}](${twin(pagePath(page))}) · PassBook API reference. Authenticate with \`Authorization: Bearer $PASSBOOK_KEY\`.`,
    '',
    opMarkdown(op, site.baseUrl, 1),
  ].join('\n')}\n`;
}

export function homeMarkdown(site: Site): string {
  const out = [
    '# PassBook developers',
    '',
    `Create Apple, Google and Samsung passes from your code, change them, hear back through webhooks. Your sandbox renders every pass as a test preview; nothing is issued. ${operations(site.opCount)}, REST and JSON.`,
    '',
    '## Reference',
    '',
  ];
  for (const g of site.groups) {
    out.push(`### ${g.label}`, '');
    for (const p of g.pages)
      out.push(`- [${p.label}](${twin(pagePath(p))}): ${operations(p.ops.length)}`);
    out.push('');
  }
  out.push(`OpenAPI: ${site.baseUrl}${PATHS.openapi}`);
  return `${out.join('\n')}\n`;
}

export function guidesIndexMarkdown(guides: Guide[]): string {
  const out = [`# ${DEV_COPY.slots.guides.title}`, '', DEV_COPY.slots.guides.line, ''];
  for (const { step, items } of groupByStep(guides, (g) => g.meta.id)) {
    out.push(`## ${step.label}`, '');
    for (const g of items) out.push(`- [${g.meta.title}](${twin(g.url)}): ${g.meta.line}`);
    out.push('');
  }
  return `${out.join('\n').trimEnd()}\n`;
}

/** https://llmstxt.org: a title, a summary and links to the markdown twins. */
export function llmsTxt(site: Site, guides: Guide[] = []): string {
  const out = [
    '# PassBook API',
    '',
    '> Create and update Apple, Google and Samsung wallet passes over a REST API. Authenticate with a bearer key in `PASSBOOK_KEY`. Sandbox keys render previews and never issue a real pass.',
    '',
    `Every page has a markdown twin (add \`.md\`). The full OpenAPI document is at ${site.baseUrl}${PATHS.openapi}.`,
    '',
  ];
  for (const g of site.groups) {
    out.push(`## ${g.label}`, '');
    for (const p of g.pages)
      out.push(
        `- [${p.label}](${site.baseUrl}${twin(pagePath(p))}): ${p.ops
          .map((o) => o.title)
          .slice(0, 4)
          .join(', ')}`,
      );
    out.push('');
  }
  out.push(
    '## Guides',
    '',
    `- [Quickstart](${site.baseUrl}${twin(PATHS.quickstart)}): your first pass in five steps`,
    ...guides.map((g) => `- [${g.meta.title}](${site.baseUrl}${twin(g.url)}): ${g.meta.line}`),
    '',
    '## Optional',
    '',
    `- [Overview](${site.baseUrl}${twin(PATHS.home)})`,
    `- [Errors](${site.baseUrl}${twin(PATHS.errors)}): every error code, with its status and fix; each code has its own page, add \`.md\``,
    `- [Webhooks](${site.baseUrl}${twin(PATHS.webhooks)})`,
    `- [Changelog](${site.baseUrl}${twin(PATHS.changelog)})`,
    `- [Protocols](${site.baseUrl}${twin(PATHS.protocols)})`,
  );
  return `${out.join('\n')}\n`;
}
