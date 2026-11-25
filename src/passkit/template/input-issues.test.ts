import { describe, expect, it } from 'vitest';
import type { TemplateManifest } from '../types.ts';
import { checkInput } from './manifest.ts';

const manifest: TemplateManifest = {
  schema: 1,
  name: 'T',
  inputs: {
    type: 'object',
    required: ['ticketId', 'holder'],
    properties: {
      ticketId: { type: 'string', minLength: 1 },
      holder: { type: 'string' },
    },
  },
  sample: { ticketId: 'A1', holder: 'Alex' },
  bindings: [{ to: { field: 'holder' }, value: '{{holder}}' }],
  display: { title: '{{holder}}' },
};

describe('checkInput required issues', () => {
  it('names the missing field under input', () => {
    const issues = checkInput(manifest, { holder: 'Alex' });
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'INPUT',
      path: 'input.ticketId',
      message: 'ticketId is required.',
    });
  });

  it('reports each missing field', () => {
    expect(checkInput(manifest, {}).map((i) => i.path)).toEqual(['input.ticketId', 'input.holder']);
  });

  it('leaves other issues on the field path', () => {
    const issues = checkInput(manifest, { ticketId: '', holder: 'Alex' });
    expect(issues.map((i) => i.path)).toEqual(['ticketId']);
  });
});
