/** The shared shell of the five type compilers: requirements, size limit, identity block. */
import type { CompileOptions, CompileResult, WalletCompiler, WalletPassView } from '../types.ts';
import { Ctx } from './ctx.ts';
import { COMPILER_REVISION, MAX_BODY_BYTES } from './limits.ts';
import { unsupportedParts } from './parts.ts';
import type { GoogleBodies, GoogleType } from './types.ts';

export interface TypeSpec<T extends GoogleType> {
  type: T;
  /** Why the view cannot be this type, from its roles. */
  unmet(view: WalletPassView): string | undefined;
  /** The bodies, or the reason found while building (a typed class needs a logo). */
  build(ctx: Ctx): GoogleBodies[T] | string;
}

export interface GoogleCompiler extends WalletCompiler {
  target: 'google';
  googleType: GoogleType;
}

const bytes = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length;
const unsatisfied = (type: GoogleType, message: string): CompileResult => ({
  type,
  items: [],
  blocked: { code: 'TYPE_UNSATISFIED', message },
});

export function makeCompiler<T extends GoogleType>(spec: TypeSpec<T>): GoogleCompiler {
  const run = (view: WalletPassView, options: CompileOptions, translate: boolean) => {
    const ctx = new Ctx(view, options, translate);
    const built = spec.build(ctx);
    if (typeof built !== 'string') unsupportedParts(ctx);
    return { ctx, built };
  };
  const oversize = (b: GoogleBodies[GoogleType]) =>
    bytes(b.classBody) > MAX_BODY_BYTES || bytes(b.objectBody) > MAX_BODY_BYTES;
  return {
    target: 'google',
    googleType: spec.type,
    revision: COMPILER_REVISION,
    compile(view, options) {
      const reason = spec.unmet(view);
      if (reason) return unsatisfied(spec.type, reason);
      let attempt = run(view, options, true);
      if (typeof attempt.built !== 'string' && oversize(attempt.built)) {
        attempt = run(view, options, false);
        attempt.ctx.note(
          'localization.strings',
          '',
          'difference',
          'Translations left out: the body is over the size limit.',
        );
      }
      const { ctx, built } = attempt;
      if (typeof built === 'string') return unsatisfied(spec.type, built);
      const [tooLong] = ctx.tooLong;
      return {
        type: spec.type,
        items: ctx.items,
        ...(tooLong ? { blocked: { code: 'IDENTITY_TOO_LONG', message: tooLong } } : built),
      };
    },
  };
}
