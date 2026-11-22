import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { expectProblem } from '../../../test/helpers/denial.ts';
import { handleError } from './error-handler.ts';
import { ValidationError } from './errors.ts';
import { createRouter, register } from './openapi.ts';

describe('a route that names its validation failure', () => {
  const app = createRouter();
  app.onError(handleError);
  const body = z.strictObject({ a: z.string() });
  register(
    app,
    't',
    {
      method: 'post',
      path: '/named',
      summary: 'x',
      public: true,
      body,
      invalid: (error) =>
        error.issues.some((i) => i.code === 'unrecognized_keys')
          ? new ValidationError('Named.', [], 'NAMED_REFUSAL')
          : undefined,
    },
    (c) => c.json({ ok: true }),
  );
  register(app, 't', { method: 'post', path: '/plain', summary: 'x', public: true, body }, (c) =>
    c.json({ ok: true }),
  );
  const post = (path: string, json: unknown) =>
    app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(json),
    });

  it('answers with its own error when it names one, and VALIDATION otherwise', async () => {
    await expectProblem(await post('/named', { a: 'x', b: 1 }), 422, 'NAMED_REFUSAL');
    await expectProblem(await post('/named', { a: 1 }), 422, 'VALIDATION');
  });

  it('leaves a route without the hook on VALIDATION', async () => {
    await expectProblem(await post('/plain', { a: 'x', b: 1 }), 422, 'VALIDATION');
  });
});
