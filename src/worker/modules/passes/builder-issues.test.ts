import { describe, expect, it } from 'vitest';
import { checkInput } from '../../../passkit/template/manifest.ts';
import type { TemplateManifest } from '../../../passkit/types.ts';
import { buildIssue } from './builder-issues.ts';

const manifest: TemplateManifest = {
  schema: 1,
  name: 'T',
  inputs: {
    type: 'object',
    required: ['ticketId'],
    properties: {
      ticketId: { type: 'string', minLength: 1 },
      upcomingEvents: {
        type: 'array',
        items: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
      },
    },
  },
  sample: { ticketId: 'A1' },
  bindings: [{ to: { field: 'ticketId' }, value: '{{ticketId}}' }],
  display: { title: '{{ticketId}}' },
};

const issues = (input: Record<string, unknown>) =>
  checkInput(manifest, input as never).map((i) => buildIssue({ ...i, message: i.message }));

describe('buildIssue', () => {
  it('names a missing top-level input', () => {
    expect(issues({})[0]).toMatchObject({
      path: 'input.ticketId',
      message: 'ticketId is required.',
    });
  });

  it('keeps the list position of a nested missing input', () => {
    expect(issues({ ticketId: 'A1', upcomingEvents: [{ name: 'x' }, {}] })[0]).toMatchObject({
      path: 'input.upcomingEvents/1/name',
      message: 'upcomingEvents/1/name is required.',
    });
  });

  it('puts other input issues under input', () => {
    expect(issues({ ticketId: '' })[0]?.path).toBe('input.ticketId');
  });

  it('leaves non-input issues alone', () => {
    expect(buildIssue({ path: 'pass.json', message: 'x', code: 'PASS' })).toEqual({
      path: 'pass.json',
      message: 'x',
      code: 'PASS',
    });
  });
});
