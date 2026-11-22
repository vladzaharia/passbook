import type { Json, Personalization } from '../../../passkit/types.ts';
import type {
  CompileResult,
  WalletCompiler,
  WalletPassView,
} from '../../../passkit/wallets/types.ts';
import { canonicalJson } from '../templates/package/hash.ts';

/**
 * Class-level fields (event name, venue, date, program, logo) belong to every pass of a Google class, so
 * they may depend only on template constants and on the inputs `google.classKey` reads. Anything else would
 * make two passes of one class disagree, and the class can only hold one answer.
 */
const NOT_CONSTANT =
  'Google class fields depend on pass data. Use only template values or the inputs of google.classKey.';

const CLASS_KEY_INPUT = /\binput\.([A-Za-z0-9_]+)/g;

/** The sample with every input the class key does not read changed. */
export function perturbSample(sample: Personalization, classKey: unknown): Personalization {
  const kept = new Set(
    typeof classKey === 'string' ? [...classKey.matchAll(CLASS_KEY_INPUT)].map((m) => m[1]) : [],
  );
  const out: Personalization = {};
  for (const [name, value] of Object.entries(sample)) {
    const changed: Json | undefined =
      kept.has(name) || value === null || typeof value === 'object'
        ? value
        : typeof value === 'number'
          ? value + 1
          : typeof value === 'string'
            ? `${value} x`
            : value;
    if (changed !== undefined) out[name] = changed;
  }
  return out;
}

/** The compiler as the review sees it: blocked when the class body moves with pass data. */
export function withClassRule(
  compiler: WalletCompiler,
  perturbedView: () => WalletPassView,
): WalletCompiler {
  return {
    ...compiler,
    compile(view, options): CompileResult {
      const result = compiler.compile(view, options);
      if (result.blocked || result.classBody === undefined) return result;
      let view2: WalletPassView;
      try {
        view2 = perturbedView();
      } catch {
        // A sample that cannot be changed and still build is not evidence either way.
        return result;
      }
      const other = compiler.compile(view2, options).classBody;
      return other !== undefined && canonicalJson(other) !== canonicalJson(result.classBody)
        ? { ...result, blocked: { code: 'TYPE_UNSATISFIED', message: NOT_CONSTANT } }
        : result;
    },
  };
}
