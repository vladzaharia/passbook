import { WALLET_CAPABILITIES } from '../../../generated/wallet-capabilities.ts';
import { WALLET_ART_RULES } from '../../../passkit/template/wallets/art-rules.ts';
import { FIDELITY_REVISION } from '../../../passkit/wallets/fidelity.ts';
import { googleCompiler } from '../../../passkit/wallets/google/compilers.ts';
import { samsungCompiler } from '../../../passkit/wallets/samsung/index.ts';
import type { WalletCompiler } from '../../../passkit/wallets/types.ts';
import { sha256Hex } from '../../platform/ids.ts';
import { canonicalJson } from '../templates/package/hash.ts';
import { CLASS_RULE_REVISION } from './projection-class-rule.ts';
import type { NativeProvider } from './projection-contract.ts';

export const COMPILERS: Record<NativeProvider, WalletCompiler> = {
  google: googleCompiler,
  samsung: samsungCompiler,
};

/** The generated matrix and the art rules are constants of the build: hashed once per isolate. */
const staticPins = new Map<NativeProvider, Promise<string>>();
const staticPin = (provider: NativeProvider): Promise<string> => {
  let pin = staticPins.get(provider);
  if (!pin) {
    pin = sha256Hex(
      canonicalJson({
        capabilities: WALLET_CAPABILITIES[provider],
        art: WALLET_ART_RULES[provider],
      }),
    );
    staticPins.set(provider, pin);
  }
  return pin;
};

/**
 * Everything but the version that decides a report: compiler, fidelity engine, matrix, art rules.
 * Code the pin cannot hash (the view, behaviors, text rules) is covered by the guard test
 * `src/passkit/wallets/pipeline-guard.test.ts`: a changed report needs a revision bump.
 */
export async function pipelineRevision(provider: NativeProvider): Promise<string> {
  return sha256Hex(
    canonicalJson({
      compiler: COMPILERS[provider].revision,
      fidelity: FIDELITY_REVISION,
      // The class field rule joins a Google report (CW9b): a changed rule re-opens review, like a compiler change.
      ...(provider === 'google' ? { rule: CLASS_RULE_REVISION } : {}),
      static: await staticPin(provider),
    }),
  );
}
