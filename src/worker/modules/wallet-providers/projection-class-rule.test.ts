// R2-M1: Google class fields may depend only on template values and the class key's inputs.
import { afterEach, describe, expect, it } from 'vitest';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import type { CompileResult } from '../../../passkit/wallets/types.ts';
import { getVersion } from '../templates/repo.ts';
import { computeProjectionPins } from './projection-pins.ts';
import { installV2Env, setup } from './projection-v2-test-fixtures.ts';

installV2Env();
let undo: (() => void) | undefined;
afterEach(() => undo?.());

/** A compiler whose class body reads the first field's text, as a template mapping pass data would. */
function classReads(read: (text: string) => string): void {
  const { compile } = googleCompiler;
  googleCompiler.compile = (view, options): CompileResult => {
    const result = compile(view, options);
    const text = view.fields[0]?.text ?? '';
    return {
      ...result,
      classBody: { ...(result.classBody as object), eventName: read(text) },
    };
  };
  undo = () => {
    googleCompiler.compile = compile;
  };
}

describe('the class field rule at release review', () => {
  it('blocks a design whose class fields move with pass data, with the reason', async () => {
    classReads((text) => text);
    const kit = await setup();
    const version = await getVersion(kit.ctx.env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { report } = await computeProjectionPins(kit.ctx, 'google', version);
    expect(report.status.kind).toBe('blocked');
    expect(JSON.stringify(report)).toContain('depend on pass data');
  });

  it('passes a design whose class fields are template constants', async () => {
    classReads(() => 'Gala');
    const kit = await setup();
    const version = await getVersion(kit.ctx.env.DB, kit.templateId, kit.version);
    if (!version) throw new Error('Version missing.');
    const { report } = await computeProjectionPins(kit.ctx, 'google', version);
    expect(report.status.kind).not.toBe('blocked');
  });
});
