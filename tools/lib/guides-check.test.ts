import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readGuideFiles } from '../../src/web/developers/guide/load.ts';
import { guideExamples, loadInputs } from '../../src/web/developers/model/load.ts';
import { buildSite } from '../../src/web/developers/model/site.ts';
import { guideFailures } from './guides-check.ts';

const root = resolve(import.meta.dirname, '../..');
const site = buildSite(loadInputs(root));
const examples = guideExamples(resolve(root, 'docs/developers/snippets/guides'));
const files = readGuideFiles(root);

/** The real guides with one file's text changed. */
function check(id: string, edit: (text: string) => string): string[] {
  return guideFailures(
    files.map((f) => (f.file.endsWith(`/${id}.md`) ? { ...f, text: edit(f.text) } : f)),
    examples,
    site,
  );
}

describe('guideFailures', () => {
  it('passes the guides as written', () => {
    expect(guideFailures(files, examples, site)).toEqual([]);
  });

  it('catches a line that differs from DEV_GUIDES', () => {
    expect(
      check('test-mode', (t) => t.replace('line: Inbox, reset, limits', 'line: Other')).join(
        '\n',
      ),
    ).toContain('differs from DEV_GUIDES');
  });

  it('catches a broken link, an unknown anchor and a relative link', () => {
    expect(check('go-live', (t) => `${t}\n[x](/developers/guides/nowhere)\n`).join('\n')).toContain(
      'points at no page',
    );
    expect(
      check('go-live', (t) =>
        t.replace(
          '/developers/guides/react-to-events',
          '/developers/guides/react-to-events#no-such',
        ),
      ).join('\n'),
    ).toContain('no such anchor');
    expect(check('go-live', (t) => `${t}\n[x](react-to-events)\n`).join('\n')).toContain(
      'points at no page',
    );
  });

  it('catches an unknown operation, an unknown snippet and an id that differs from the file', () => {
    expect(
      check('nfc', (t) => t.replace('nfc-tags.postNfcTagTypes', 'nfc-tags.nope')).join('\n'),
    ).toContain('no operation nfc-tags.nope');
    expect(check('go-live', (t) => `${t}\n{{show no-such-snippet}}\n`).join('\n')).toContain(
      'no snippet no-such-snippet',
    );
    expect(check('nfc', (t) => t.replace('id: nfc', 'id: nfd')).join('\n')).toContain(
      'must match the file name',
    );
  });

  it('holds the owner rules: a runnable step, a result, no phone steps, NFC as a preview', () => {
    expect(check('test-mode', (t) => t.replaceAll('{{run', '{{show')).join('\n')).toContain(
      'no runnable step',
    );
    expect(check('test-mode', (t) => t.replace('## Result', '## Done')).join('\n')).toContain(
      'must be "Result"',
    );
    expect(
      check('test-mode', (t) =>
        `${t}\nOpen it on your phone.\n`.replace('Open it on your phone', 'Add it on your phone'),
      ).join('\n'),
    ).toContain('phone step');
    expect(check('nfc', (t) => t.replace('status: preview', 'status: ready')).join('\n')).toContain(
      'labelled preview',
    );
  });

  it('reports a missing guide', () => {
    expect(
      guideFailures(
        files.filter((f) => !f.file.endsWith('/go-live.md')),
        examples,
        site,
      ),
    ).toContain('docs/developers/guides/go-live.md: missing');
  });
});
