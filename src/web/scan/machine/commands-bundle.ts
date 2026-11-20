import type { BundleCmd } from './bundle-peek.ts';
import type { Host } from './commands.ts';
import { inputBody, wireOf } from './commands-wire.ts';
import type { ScanDeps } from './ports.ts';

/**
 * Asks `resolve` which bundle the pass just checked in belongs to. Best effort: with no answer the
 * card stays as it was, so a failure is dropped here, not shown (the verdict already is).
 */
export function peekBundle(deps: ScanDeps, host: Pick<Host, 'dispatch'>, cmd: BundleCmd): void {
  deps.api
    .resolve(
      {
        idempotencyKey: cmd.key,
        input: inputBody(wireOf(cmd.input)),
        clientTs: deps.clock.now(),
        ...deps.base(),
      },
      { signal: new AbortController().signal },
    )
    .then(
      (answer) => {
        const bundle = answer.bundle ?? answer.card?.bundle;
        if (bundle && bundle.size > 1)
          host.dispatch({ type: 'bundle', scanId: cmd.scanId, bundle });
      },
      (error: unknown) => void error,
    );
}
