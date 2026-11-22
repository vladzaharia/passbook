import { describe, expect, it } from 'vitest';
import { expectProblem } from '../../../../test/helpers/denial.ts';
import { ruleKit } from './test-kit.ts';

describe('a rule reads its templates through the mode release', () => {
  it('creates and previews a Test rule on a Test-only template, and refuses it in Live', async () => {
    const kit = await ruleKit();
    const tpl = await kit.releasedIn(['test']);
    const body = kit.ruleBody({
      templateIds: [tpl.id],
      anchor: { kind: 'input', input: 'expires' },
    });
    const send = (path: string, mode: 'live' | 'test') =>
      kit.api(path, {
        method: 'POST',
        headers: { ...kit.auth.admin({ mode }), 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await send('/message-rules/preview', 'test')).status).toBe(200);
    const made = await send('/message-rules', 'test');
    expect(made.status, await made.clone().text()).toBe(201);
    await expectProblem(await send('/message-rules/preview', 'live'), 404, 'TEMPLATE_NOT_FOUND');
    await expectProblem(await send('/message-rules', 'live'), 404, 'TEMPLATE_NOT_FOUND');
  });
});
