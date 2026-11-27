import { DEV_COPY } from '../../../shared/copy/developers.ts';
import { STATUS_COPY } from '../../../shared/copy/developers-ops.ts';
import { opUrl, PATHS, twin } from '../../../shared/developers.ts';
import { operations } from './dates.ts';
import { pagePath } from './markdown.ts';
import type { ErrorEntry, Site } from './types.ts';

/** Markdown twins of the pages markdown.ts has no generator for (the reference pages, home and guides have theirs). */

const end = (lines: string[]) => `${lines.join('\n')}\n`;
const cell = (text: string) => text.replaceAll('|', '\\|').replaceAll('\n', ' ');
const note = (title: string, line: string, hint: string) => end([`# ${title}`, '', line, '', hint]);

export function referenceIndexMarkdown(site: Site): string {
  const out = [`# ${DEV_COPY.reference.title}`, '', DEV_COPY.reference.lede, ''];
  for (const g of site.groups) {
    out.push(`## ${g.label}`, '');
    for (const p of g.pages)
      out.push(`- [${p.label}](${twin(pagePath(p))}): ${operations(p.ops.length)}`);
    out.push('');
  }
  out.push(
    '## More',
    '',
    `- [Errors](${twin(PATHS.errors)})`,
    `- [Protocols](${twin(PATHS.protocols)})`,
  );
  return end(out);
}

export function protocolsMarkdown(site: Site): string {
  const out = ['# Protocols', '', 'Called by devices and wallets, not by integrations.', ''];
  for (const p of site.protocols)
    out.push(`- \`${p.method.toUpperCase()} ${p.path}\`: ${p.reason || p.title}`);
  return end(out);
}

export function errorsIndexMarkdown(site: Site): string {
  const out = ['# Errors', '', 'Branch on code, not on the message.', ''];
  if (site.errors.length > 0) out.push('| Code | Status | Fix |', '| --- | --- | --- |');
  for (const e of site.errors)
    out.push(
      `| [\`${e.code}\`](${twin(`${PATHS.errors}/${e.code}`)}) | ${e.status ?? ''} | ${cell(e.fix || e.title)} |`,
    );
  return end(out);
}

export function errorMarkdown(e: ErrorEntry): string {
  const out = [`# ${e.code}`, ''];
  const facts = [
    ...(e.status ? [`Status ${e.status}`] : []),
    ...(e.retryable === null ? [] : [e.retryable ? 'Retry' : 'Do not retry']),
  ];
  if (facts.length > 0) out.push(`${facts.join('. ')}.`, '');
  if (e.title !== e.code) out.push(e.title, '');
  if (e.fix) out.push('## Fix', '', e.fix, '');
  if (e.when) out.push('## When', '', e.when, '');
  if (e.usedBy.length > 0) {
    out.push('## Returned by', '');
    for (const u of e.usedBy) out.push(`- [${u.title}](${twin(opUrl(u.slug, u.anchor))})`);
  }
  return end(out);
}

export function changelogMarkdown(site: Site): string {
  const out = [
    '# Changelog',
    '',
    'Send `PassBook-Version` to opt in to a dated version; without it nothing changes.',
    '',
  ];
  for (const v of site.versions)
    out.push(`- \`PassBook-Version: ${v.date}\`: ${v.summary} ${v.migration}`);
  let day = '';
  for (const e of site.changelog) {
    if (e.date !== day) out.push('', `## ${e.date}`, '');
    day = e.date;
    out.push(`- ${e.kind}${e.breaking ? ' (breaking)' : ''}: ${e.text}`);
  }
  return end(out);
}

/** Pages that run in the browser: the twin says what the page is and where its data comes from. */
export const appTwins = {
  status: () => note(STATUS_COPY.title, STATUS_COPY.lede, `Live data: ${PATHS.statusJson}`),
};
