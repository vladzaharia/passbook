import { describe, expect, it } from 'vitest';
import { outputFailures, PAGE_BUDGET } from './developers-output-check.ts';

const page = (url: string, body = '<html></html>') => ({ file: `${url}.html`, url, body });
const NOT_FOUND = { file: '/developers/not-found.html', body: '' };

describe('outputFailures', () => {
  it('passes when every page has a twin and fits the budget', () => {
    const files = [
      page('/developers/quickstart'),
      { file: '/developers/quickstart.md', body: '# Q' },
      NOT_FOUND,
    ];
    expect(outputFailures(files)).toEqual([]);
  });

  it('names a page without a twin', () => {
    expect(outputFailures([page('/developers/quickstart'), NOT_FOUND])).toEqual([
      '/developers/quickstart: no markdown twin (/developers/quickstart.md)',
    ]);
  });

  it('names a page over the budget', () => {
    const files = [
      page('/developers/big', 'x'.repeat(PAGE_BUDGET + 1)),
      { file: '/developers/big.md', body: '' },
      NOT_FOUND,
    ];
    expect(outputFailures(files)[0]).toMatch(/^\/developers\/big: \d+ kB of HTML, over the 300 kB/);
  });

  it('names a file that mentions the CLI while it is unpublished', () => {
    const files = [
      { file: '/developers/webhooks.html', body: 'npx @passbook/cli listen' },
      NOT_FOUND,
    ];
    expect(outputFailures(files)).toEqual([
      '/developers/webhooks.html: names @passbook/cli while sdk-status.json has cli: false',
    ]);
    expect(outputFailures(files, true)).toEqual([]);
  });

  it('names an llms.txt link to a file that is not there, and a missing 404 page', () => {
    const llms = {
      file: '/developers/llms.txt',
      body: '- [A](https://x.test/developers/a.md)\n- [B](https://x.test/developers/b.md)',
    };
    expect(outputFailures([llms, { file: '/developers/a.md', body: '' }])).toEqual([
      'llms.txt lists /developers/b.md, which does not exist',
      '/developers/not-found.html is missing',
    ]);
  });
});
