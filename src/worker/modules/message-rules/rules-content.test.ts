import { beforeEach, describe, expect, it, vi } from 'vitest';
import { first, run } from '../../platform/db.ts';
import { ConflictError } from '../../platform/errors.ts';
import { resolveModeTemplate } from '../broadcasts/target-release.ts';
import { jobCtxOf } from '../delivery/delivery-test-fixtures.ts';
import { checkRule } from './check.ts';
import { type RuleKit, ruleKit } from './test-kit.ts';

vi.mock('../broadcasts/target-release.ts', async (original) => {
  const actual = await original<typeof import('../broadcasts/target-release.ts')>();
  return { ...actual, resolveModeTemplate: vi.fn(actual.resolveModeTemplate) };
});

let kit: RuleKit;
beforeEach(async () => {
  kit = await ruleKit();
});

describe('a rule check whose template content no longer matches its release', () => {
  it('pauses with its own code, not RULE_INPUT_MISSING, and reads the head without verifying it', async () => {
    const made = await kit.send('POST', '/message-rules', kit.ruleBody());
    const id = ((await made.json()) as { id: string }).id;
    const resolve = vi.mocked(resolveModeTemplate);
    resolve.mockRejectedValueOnce(
      new ConflictError('Template content changed.', 'TEMPLATE_CONTENT_CHANGED'),
    );
    await checkRule(jobCtxOf(kit), { ruleId: id, at: kit.clock.now() });
    expect(
      await first(kit.env.DB, 'SELECT state, paused_code FROM message_rules WHERE id = ?', [id]),
    ).toEqual({ state: 'paused', paused_code: 'RULE_TEMPLATE_CHANGED' });
    // A scheduled check asks for the light read.
    await run(
      kit.env.DB,
      "UPDATE message_rules SET state = 'on', paused_code = NULL WHERE id = ?",
      [id],
    );
    resolve.mockClear();
    await checkRule(jobCtxOf(kit), { ruleId: id, at: kit.clock.now() });
    expect(resolve.mock.calls[0]?.[4]).toBe(true);
  });
});
