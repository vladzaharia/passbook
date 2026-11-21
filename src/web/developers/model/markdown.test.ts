import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadInputs } from './load.ts';
import { homeMarkdown, llmsTxt, pageMarkdown, pagePath } from './markdown.ts';
import { buildSite } from './site.ts';

const root = resolve(import.meta.dirname, '../../../..');
const site = buildSite(loadInputs(root));
const passes = site.pages.find((p) => p.key === 'passes');

describe('markdown twins', () => {
  it('writes a page as headings, a field table, errors and a runnable curl sample', () => {
    expect(passes).toBeDefined();
    const md = pageMarkdown(passes as NonNullable<typeof passes>, site);
    expect(md).toMatch(/^# /);
    expect(md).toContain('Authorization: Bearer $PASSBOOK_KEY');
    expect(md).toContain('| Name | In | Type | Required | Description |');
    expect(md).toContain('| Code | Status | Fix |');
    expect(md).toContain('SDK name: `pb.passes.');
    expect(md).toMatch(/Scopes: `[a-z-]+:[a-z]+`/);
    expect(md).toContain('```sh\ncurl -X');
    expect(md).toContain('Response example:');
    expect(md.endsWith('\n')).toBe(true);
    // A cell never breaks the table.
    for (const line of md.split('\n').filter((l) => l.startsWith('| `')))
      expect(line.replace(/\\\|/g, '').split('|').length).toBeGreaterThanOrEqual(5);
  });

  it('lists the operations a key cannot call as console only', () => {
    const withConsole = site.pages.find((p) => p.consoleOnly.length > 0);
    if (!withConsole) return;
    const md = pageMarkdown(withConsole, site);
    expect(md).toContain('## Console only');
    expect(md).toContain(`- \`${withConsole.consoleOnly[0]?.method.toUpperCase()} `);
  });

  it('the home page and llms.txt link every reference page twin', () => {
    const home = homeMarkdown(site);
    const llms = llmsTxt(site);
    for (const g of site.groups)
      for (const p of g.pages) {
        expect(home).toContain(`(${pagePath(p)}.md)`);
        expect(llms).toContain(`${site.baseUrl}${pagePath(p)}.md`);
      }
    expect(home).toContain('# PassBook developers');
    expect(home).toContain(`OpenAPI: ${site.baseUrl}`);
    expect(llms).toMatch(/^# PassBook API\n\n> /);
    expect(llms).toContain('## Optional');
  });
});
