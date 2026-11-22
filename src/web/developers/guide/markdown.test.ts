import { describe, expect, it } from 'vitest';
import type { Example } from '../model/types.ts';
import { guideMarkdown } from './markdown.ts';
import type { Guide } from './model.ts';

const example: Example = {
  id: 'ex1',
  title: 'Create a pass',
  guide: 'g',
  ops: [],
  ts: 'await pb.passes.create({});',
  curl: 'curl -X POST /passes',
};

const guide = (status: 'ready' | 'preview' | 'soon', blocks: Guide['blocks']): Guide =>
  ({
    meta: { id: 'g', title: 'Guide title', line: 'A line', status },
    blocks,
    url: '/developers/guides/g',
    steps: [],
    ops: [
      {
        operationId: 'passes.create',
        method: 'post',
        path: '/passes',
        title: 'Create a pass',
        sdkCall: 'pb.passes.create',
        href: '/developers/reference/passes/create',
      },
    ],
  }) as unknown as Guide;

describe('guideMarkdown', () => {
  it('renders every block kind with absolute links', () => {
    const md = guideMarkdown(
      guide('preview', [
        { kind: 'h2', text: 'Two', id: 'two' },
        { kind: 'h3', text: 'Three', id: 'three' },
        {
          kind: 'p',
          text: 'See [create](console:passes.create) and [guides](/developers/guides).',
        },
        { kind: 'quote', text: 'Note [x](https://example.com/x)' },
        { kind: 'ul', items: ['one', 'two'] },
        { kind: 'ol', items: ['first', 'second'] },
        { kind: 'table', head: ['A', 'B'], rows: [['1', '2']] },
        { kind: 'code', lang: 'sh', text: 'echo hi\n' },
        { kind: 'diagram', name: 'lifecycle' },
        { kind: 'run', snippet: 'ex1' },
        { kind: 'show', snippet: 'missing' },
      ]),
      [example],
      'https://passbook.test',
    );
    expect(md).toContain('# Guide title');
    expect(md).toContain('Preview. A line.');
    expect(md).toContain('## Two');
    expect(md).toContain('### Three');
    expect(md).toContain('](https://passbook.test/developers/reference/passes/create)');
    expect(md).toContain('](https://passbook.test/developers/guides)');
    expect(md).toContain('> Note [x](https://example.com/x)');
    expect(md).toContain('- one\n- two');
    expect(md).toContain('1. first\n2. second');
    expect(md).toContain('| A | B |\n| --- | --- |\n| 1 | 2 |');
    expect(md).toContain('```sh\necho hi\n```');
    expect(md).toContain('```mermaid');
    expect(md).toContain('**Create a pass**');
    expect(md).toContain('```sh\ncurl -X POST /passes\n```');
    expect(md).toContain('## Operations');
    expect(md).toContain('POST /passes](https://passbook.test/developers/reference/passes/create)');
    expect(md.endsWith('/developers/guides\n')).toBe(true);
  });

  it('keeps the bare line for a guide that is not out yet', () => {
    const md = guideMarkdown(guide('soon', []), [], 'https://passbook.test');
    expect(md).toContain('\nA line\n');
    expect(md).not.toContain('Runs in your test sandbox');
  });
});
